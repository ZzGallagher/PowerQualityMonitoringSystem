param(
    [Parameter(Mandatory = $true)]
    [string]$PortName,

    [int]$SlaveId = 1,
    [int]$BaudRate = 9600,
    [ValidateSet("None", "Odd", "Even")]
    [string]$Parity = "Even",
    [int]$DataBits = 8,
    [ValidateSet("One", "Two")]
    [string]$StopBits = "One",
    [int]$TimeoutMs = 1200
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Crc16Modbus {
    param([byte[]]$Bytes)

    [uint16]$crc = 0xFFFF
    foreach ($b in $Bytes) {
        $crc = $crc -bxor [uint16]$b
        for ($i = 0; $i -lt 8; $i++) {
            if (($crc -band 0x0001) -ne 0) {
                $crc = ($crc -shr 1) -bxor 0xA001
            }
            else {
                $crc = $crc -shr 1
            }
        }
    }
    return $crc
}

function New-ReadHoldingRegistersRequest {
    param(
        [int]$Slave,
        [int]$StartAddress,
        [int]$Quantity
    )

    [byte[]]$frame = @(
        [byte]$Slave,
        [byte]0x03,
        [byte](($StartAddress -shr 8) -band 0xFF),
        [byte]($StartAddress -band 0xFF),
        [byte](($Quantity -shr 8) -band 0xFF),
        [byte]($Quantity -band 0xFF)
    )
    $crc = Get-Crc16Modbus $frame
    return $frame + @([byte]($crc -band 0xFF), [byte](($crc -shr 8) -band 0xFF))
}

function Read-ExactBytes {
    param(
        [System.IO.Ports.SerialPort]$Port,
        [int]$Count
    )

    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Port.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) {
            throw "串口读取超时或无数据。"
        }
        $offset += $read
    }
    return $buffer
}

function Invoke-ModbusRead {
    param(
        [System.IO.Ports.SerialPort]$Port,
        [int]$Slave,
        [int]$StartAddress,
        [int]$Quantity
    )

    $request = New-ReadHoldingRegistersRequest -Slave $Slave -StartAddress $StartAddress -Quantity $Quantity
    $Port.DiscardInBuffer()
    $Port.Write($request, 0, $request.Length)

    $header = Read-ExactBytes -Port $Port -Count 3
    if ($header[0] -ne [byte]$Slave) {
        throw ("从站地址不匹配。期望 {0}，实际 {1}。" -f $Slave, $header[0])
    }
    if (($header[1] -band 0x80) -ne 0) {
        $rest = Read-ExactBytes -Port $Port -Count 2
        $exceptionCode = $header[2]
        throw ("Modbus异常响应。功能码 0x{0:X2}，异常码 0x{1:X2}。" -f $header[1], $exceptionCode)
    }
    if ($header[1] -ne 0x03) {
        throw ("功能码不匹配。期望 0x03，实际 0x{0:X2}。" -f $header[1])
    }

    $byteCount = [int]$header[2]
    $bodyAndCrc = Read-ExactBytes -Port $Port -Count ($byteCount + 2)
    $response = $header + $bodyAndCrc
    $payloadWithoutCrc = $response[0..($response.Length - 3)]
    $actualCrcLow = $response[$response.Length - 2]
    $actualCrcHigh = $response[$response.Length - 1]
    $expectedCrc = Get-Crc16Modbus $payloadWithoutCrc

    if ($actualCrcLow -ne [byte]($expectedCrc -band 0xFF) -or $actualCrcHigh -ne [byte](($expectedCrc -shr 8) -band 0xFF)) {
        throw "CRC校验失败。"
    }
    if ($byteCount -ne ($Quantity * 2)) {
        throw ("响应字节数不匹配。期望 {0}，实际 {1}。" -f ($Quantity * 2), $byteCount)
    }

    $registers = @()
    for ($i = 0; $i -lt $Quantity; $i++) {
        $hi = [int]$bodyAndCrc[$i * 2]
        $lo = [int]$bodyAndCrc[$i * 2 + 1]
        $registers += (($hi -shl 8) -bor $lo)
    }
    return $registers
}

function Convert-Int16 {
    param([int]$Value)
    if (($Value -band 0x8000) -ne 0) {
        return $Value - 0x10000
    }
    return $Value
}

function Convert-UInt32BE {
    param([int[]]$Registers)
    return ([uint32]$Registers[0] -shl 16) -bor [uint32]$Registers[1]
}

$pointDefinitions = @(
    @{ Code = "ua"; Name = "A相电压值"; Offset = 0; Type = "uint16"; Scale = 0.1; Unit = "V" },
    @{ Code = "ub"; Name = "B相电压值"; Offset = 1; Type = "uint16"; Scale = 0.1; Unit = "V" },
    @{ Code = "uc"; Name = "C相电压值"; Offset = 2; Type = "uint16"; Scale = 0.1; Unit = "V" },
    @{ Code = "uab"; Name = "AB线电压"; Offset = 3; Type = "uint16"; Scale = 0.1; Unit = "V" },
    @{ Code = "ubc"; Name = "BC线电压"; Offset = 4; Type = "uint16"; Scale = 0.1; Unit = "V" },
    @{ Code = "uac"; Name = "AC线电压"; Offset = 5; Type = "uint16"; Scale = 0.1; Unit = "V" },
    @{ Code = "ia"; Name = "A相电流"; Offset = 6; Type = "uint16"; Scale = 0.001; Unit = "A" },
    @{ Code = "ib"; Name = "B相电流"; Offset = 7; Type = "uint16"; Scale = 0.001; Unit = "A" },
    @{ Code = "ic"; Name = "C相电流"; Offset = 8; Type = "uint16"; Scale = 0.001; Unit = "A" },
    @{ Code = "pa"; Name = "A相有功功率"; Offset = 9; Type = "int16"; Scale = 0.001; Unit = "W" },
    @{ Code = "pb"; Name = "B相有功功率"; Offset = 10; Type = "int16"; Scale = 0.001; Unit = "W" },
    @{ Code = "pc"; Name = "C相有功功率"; Offset = 11; Type = "int16"; Scale = 0.001; Unit = "W" },
    @{ Code = "p_total"; Name = "总有功功率"; Offset = 12; Type = "int16"; Scale = 0.001; Unit = "W" },
    @{ Code = "qa"; Name = "A相无功功率"; Offset = 13; Type = "int16"; Scale = 0.001; Unit = "var" },
    @{ Code = "qb"; Name = "B相无功功率"; Offset = 14; Type = "int16"; Scale = 0.001; Unit = "var" },
    @{ Code = "qc"; Name = "C相无功功率"; Offset = 15; Type = "int16"; Scale = 0.001; Unit = "var" },
    @{ Code = "q_total"; Name = "总无功功率"; Offset = 16; Type = "int16"; Scale = 0.001; Unit = "var" },
    @{ Code = "pfa"; Name = "A相功率因数"; Offset = 17; Type = "int16"; Scale = 0.001; Unit = "" },
    @{ Code = "pfb"; Name = "B相功率因数"; Offset = 18; Type = "int16"; Scale = 0.001; Unit = "" },
    @{ Code = "pfc"; Name = "C相功率因数"; Offset = 19; Type = "int16"; Scale = 0.001; Unit = "" },
    @{ Code = "pf_total"; Name = "总功率因数"; Offset = 20; Type = "int16"; Scale = 0.001; Unit = "" },
    @{ Code = "sa"; Name = "A相视在功率"; Offset = 21; Type = "uint16"; Scale = 0.001; Unit = "VA" },
    @{ Code = "sb"; Name = "B相视在功率"; Offset = 22; Type = "uint16"; Scale = 0.001; Unit = "VA" },
    @{ Code = "sc"; Name = "C相视在功率"; Offset = 23; Type = "uint16"; Scale = 0.001; Unit = "VA" },
    @{ Code = "s_total"; Name = "总视在功率"; Offset = 24; Type = "uint16"; Scale = 0.001; Unit = "VA" },
    @{ Code = "frequency"; Name = "频率F"; Offset = 25; Type = "uint16"; Scale = 0.01; Unit = "Hz" },
    @{ Code = "u0"; Name = "零序电压"; Offset = 26; Type = "uint16"; Scale = 0.1; Unit = "V" },
    @{ Code = "i0"; Name = "零序电流"; Offset = 27; Type = "uint16"; Scale = 0.001; Unit = "A" }
)

$parityValue = [System.IO.Ports.Parity]::$Parity
$stopBitsValue = [System.IO.Ports.StopBits]::$StopBits
$port = [System.IO.Ports.SerialPort]::new($PortName, $BaudRate, $parityValue, $DataBits, $stopBitsValue)
$port.ReadTimeout = $TimeoutMs
$port.WriteTimeout = $TimeoutMs

try {
    $port.Open()
    Write-Host ("已打开 {0}: slave={1}, baud={2}, parity={3}, dataBits={4}, stopBits={5}" -f $PortName, $SlaveId, $BaudRate, $Parity, $DataBits, $StopBits)

    $secondary = Invoke-ModbusRead -Port $port -Slave $SlaveId -StartAddress 0x0100 -Quantity 28
    Write-Host ""
    Write-Host "二次侧电参量 0100H-011BH"
    foreach ($point in $pointDefinitions) {
        $raw = [int]$secondary[$point.Offset]
        if ($point.Type -eq "int16") {
            $raw = Convert-Int16 $raw
        }
        $value = [double]$raw * [double]$point.Scale
        $unitText = if ([string]::IsNullOrWhiteSpace($point.Unit)) { "" } else { " $($point.Unit)" }
        Write-Host ("{0,-18} {1,-14} raw={2,8} value={3}{4}" -f $point.Code, $point.Name, $raw, $value, $unitText)
    }

    $energyRegs = Invoke-ModbusRead -Port $port -Slave $SlaveId -StartAddress 0x003F -Quantity 2
    $energyRaw = Convert-UInt32BE $energyRegs
    $energy = [double]$energyRaw / 1000.0
    Write-Host ""
    Write-Host ("ep_import          吸收有功电能二次侧 raw={0} value={1} kWh" -f $energyRaw, $energy)

    $angleRegs = Invoke-ModbusRead -Port $port -Slave $SlaveId -StartAddress 0x008C -Quantity 3
    Write-Host ""
    Write-Host ("angle_ua           电压UA相角 raw={0} value={1} deg" -f $angleRegs[0], ([double]$angleRegs[0] / 10.0))
    Write-Host ("angle_ub           电压UB相角 raw={0} value={1} deg" -f $angleRegs[1], ([double]$angleRegs[1] / 10.0))
    Write-Host ("angle_uc           电压UC相角 raw={0} value={1} deg" -f $angleRegs[2], ([double]$angleRegs[2] / 10.0))

    $unbalanceRegs = Invoke-ModbusRead -Port $port -Slave $SlaveId -StartAddress 0x0700 -Quantity 2
    Write-Host ""
    Write-Host ("voltage_unbalance  电压不平衡度 raw={0} value={1} %" -f $unbalanceRegs[0], ([double]$unbalanceRegs[0] / 10.0))
    Write-Host ("current_unbalance  电流不平衡度 raw={0} value={1} %" -f $unbalanceRegs[1], ([double]$unbalanceRegs[1] / 10.0))

    $didoRegs = Invoke-ModbusRead -Port $port -Slave $SlaveId -StartAddress 0x0022 -Quantity 1
    Write-Host ""
    Write-Host ("dido_status        开关量输入输出状态 raw=0x{0:X4}" -f $didoRegs[0])
}
finally {
    if ($port.IsOpen) {
        $port.Close()
    }
}
