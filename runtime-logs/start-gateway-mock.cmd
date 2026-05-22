@echo off
pushd "D:\#.Projects\PowerQualityMonitoringSystem\???1\amc_gateway"
set PYTHONPATH=.\src
python -m amc_gateway run --config meter_config.example.json --mode mock
pause
