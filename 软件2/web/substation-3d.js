import * as THREE from "three";
import { OrbitControls } from "./assets/three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "./assets/three/examples/jsm/loaders/GLTFLoader.js";

const STATE_COPY = {
  closed: "通路",
  open: "断路",
  unknown: "未知",
};

const STATE_COLORS = {
  closed: { color: 0x10b981, emissive: 0x13f287 },
  open: { color: 0xef4444, emissive: 0x7f1d1d },
  unknown: { color: 0x94a3b8, emissive: 0x334155 },
};

export function initSubstation3dPage(options) {
  return new Substation3dPage(options);
}

class Substation3dPage {
  constructor({
    config,
    viewport,
    statusNode,
    circuitListNode,
    resetButton,
    fitButton,
    viewButtons,
    onCircuitSelect,
    onCircuitOpen,
    onCircuitHover,
    onCircuitLeave,
  }) {
    this.config = config;
    this.viewport = viewport;
    this.statusNode = statusNode;
    this.circuitListNode = circuitListNode;
    this.resetButton = resetButton;
    this.fitButton = fitButton;
    this.viewButtons = Array.from(viewButtons ?? []);
    this.onCircuitSelect = onCircuitSelect;
    this.onCircuitOpen = onCircuitOpen;
    this.onCircuitHover = onCircuitHover;
    this.onCircuitLeave = onCircuitLeave;
    this.objectIndex = new Map();
    this.circuitByObjectUuid = new Map();
    this.originalRotations = new Map();
    this.lastStates = new Map();
    this.ignoredObjects = new Set(config.ignoredObjects ?? []);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pickTargets = [];
    this.hoveredCircuitId = null;
    this.usingFallbackModel = false;

    this.setupScene();
    this.bindControls();
    this.renderCircuitList();
    this.loadModel();
    this.animate();
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf6f8fb);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    const cameraPosition = this.config.camera?.position ?? [3.2, 2.4, 5.2];
    this.camera.position.set(...cameraPosition);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.viewport.appendChild(this.renderer.domElement);

    const target = this.config.camera?.target ?? [0, 1.2, 0];
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(...target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 18;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd7dde7, 1.9));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(4, 6, 5);
    keyLight.castShadow = true;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xbcd7ff, 0.9);
    fillLight.position.set(-5, 3, -4);
    this.scene.add(fillLight);

    const grid = new THREE.GridHelper(7, 14, 0xb8c2d0, 0xdde4ee);
    grid.position.y = -0.02;
    this.scene.add(grid);

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  bindControls() {
    this.resetButton?.addEventListener("click", () => this.resetCamera());
    this.fitButton?.addEventListener("click", () => this.fitCameraToModel());
    this.viewButtons.forEach((button) => {
      button.addEventListener("click", () => this.setPresetView(button.dataset.substationView));
    });
    this.renderer.domElement.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    this.renderer.domElement.addEventListener("pointerleave", () => this.clearHover());
    this.renderer.domElement.addEventListener("click", (event) => this.handleClick(event));
    this.renderer.domElement.addEventListener("dblclick", (event) => this.handleDoubleClick(event));
  }

  loadModel() {
    this.setStatus("正在加载 AA1 三维模型...");
    const loader = new GLTFLoader();
    loader.load(
      this.config.modelAsset,
      (gltf) => {
        this.model = gltf.scene;
        this.scene.add(this.model);
        this.indexObjects();
        this.fitCameraToModel();
        this.applyStoredStates();
        this.reportModelStatus();
      },
      undefined,
      () => {
        this.usingFallbackModel = true;
        this.model = this.createFallbackCabinet();
        this.scene.add(this.model);
        this.indexObjects();
        this.fitCameraToModel();
        this.applyStoredStates();
        this.setStatus("未找到 AA1.glb，已使用临时三维柜体占位。导出模型后会自动加载正式文件。", true);
      },
    );
  }

  indexObjects() {
    this.objectIndex.clear();
    this.circuitByObjectUuid.clear();
    this.pickTargets = [];
    this.originalRotations.clear();
    this.model.traverse((object) => {
      if (!object.name) return;
      this.objectIndex.set(object.name, object);
      if (this.ignoredObjects.has(object.name)) {
        object.visible = false;
      }
      this.originalRotations.set(object.name, object.rotation.clone());
      if (object.isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    this.bindCircuitObjects();
  }

  bindCircuitObjects() {
    this.config.circuits.forEach((circuit) => {
      const objectNames = this.circuitPickObjectNames(circuit);
      objectNames.forEach((objectName) => {
        const object = this.objectIndex.get(objectName);
        if (!object) return;
        object.traverse((node) => {
          node.userData.circuitId = circuit.circuitId;
          this.circuitByObjectUuid.set(node.uuid, circuit.circuitId);
          if (node.isMesh && !this.pickTargets.includes(node)) this.pickTargets.push(node);
        });
      });
    });
  }

  circuitPickObjectNames(circuit) {
    return [
      circuit.modelObject,
      circuit.drawerObject,
      circuit.lampObject,
      circuit.handleObject,
      ...(circuit.pickObjects ?? []),
    ].filter(Boolean);
  }

  handlePointerMove(event) {
    const hit = this.pickCircuit(event);
    this.renderer.domElement.style.cursor = hit ? "pointer" : "";
    if (!hit) {
      this.clearHover();
      return;
    }
    if (hit.circuitId !== this.hoveredCircuitId) {
      this.hoveredCircuitId = hit.circuitId;
    }
    this.onCircuitHover?.(hit.circuitId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  handleClick(event) {
    const hit = this.pickCircuit(event);
    if (!hit) return;
    this.onCircuitSelect?.(hit.circuitId);
  }

  handleDoubleClick(event) {
    const hit = this.pickCircuit(event);
    if (!hit) return;
    event.preventDefault();
    this.onCircuitOpen?.(hit.circuitId);
  }

  pickCircuit(event) {
    if (!this.pickTargets.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.pickTargets, false);
    const target = intersects.find((item) => item.object.visible)?.object;
    if (!target) return null;
    const circuitId = this.circuitByObjectUuid.get(target.uuid) ?? target.userData.circuitId;
    return circuitId ? { circuitId, object: target } : null;
  }

  clearHover() {
    if (!this.hoveredCircuitId) return;
    this.hoveredCircuitId = null;
    this.renderer.domElement.style.cursor = "";
    this.onCircuitLeave?.();
  }

  applyTopologyState(payload) {
    const switches = payload?.switches ?? [];
    this.config.circuits.forEach((circuit) => {
      const state = this.resolveCircuitState(circuit, switches);
      this.lastStates.set(circuit.circuitId, state);
      this.applyCircuitState(circuit, state);
    });
    this.renderCircuitList();
  }

  resolveCircuitState(circuit, switches) {
    const exact = switches.find((item) => item.circuitId === circuit.circuitId || item.circuit_id === circuit.circuitId);
    if (exact) return this.switchItemToState(exact, circuit);

    const byPoint = switches.find((item) => {
      const meterId = item.meterId ?? item.meter_id;
      const pointCode = item.pointCode ?? item.point_code;
      return meterId === circuit.meterId && pointCode === circuit.pointCode;
    });
    if (byPoint) return this.switchItemToState(byPoint, circuit);

    return { key: "unknown", sampleTime: null, quality: "unknown" };
  }

  switchItemToState(item, circuit) {
    let status = item.switchStatus ?? item.switch_status;
    const rawValue = item.rawValue ?? item.raw_value;
    const bitMask = item.bitMask ?? item.bit_mask ?? circuit.bitMask;
    if (bitMask && rawValue !== null && rawValue !== undefined) {
      const raw = Number(rawValue);
      status = Number.isFinite(raw) ? (raw & Number(bitMask) ? 1 : 0) : null;
    }
    if (status === 1 || status === "1" || status === true) {
      return { key: "closed", sampleTime: item.sampleTime ?? item.sample_time ?? null, quality: item.quality ?? "good" };
    }
    if (status === 0 || status === "0" || status === false) {
      return { key: "open", sampleTime: item.sampleTime ?? item.sample_time ?? null, quality: item.quality ?? "good" };
    }
    return { key: "unknown", sampleTime: item.sampleTime ?? item.sample_time ?? null, quality: item.quality ?? "unknown" };
  }

  applyStoredStates() {
    this.config.circuits.forEach((circuit) => {
      const state = this.lastStates.get(circuit.circuitId) ?? { key: "unknown", sampleTime: null, quality: "unknown" };
      this.applyCircuitState(circuit, state);
    });
  }

  applyCircuitState(circuit, state) {
    const lamp = this.objectIndex.get(circuit.lampObject);
    if (lamp) this.tintObject(lamp, STATE_COLORS[state.key] ?? STATE_COLORS.unknown);

    const handle = this.objectIndex.get(circuit.handleObject);
    if (handle) {
      const rotation = state.key === "closed" ? circuit.closedRotation : circuit.openRotation;
      this.applyHandleRotation(handle, circuit.handleObject, rotation ?? {});
    }
  }

  tintObject(object, colorSet) {
    object.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material, index) => {
        if (!material.userData.substation3dCloned) {
          const cloned = material.clone();
          cloned.userData.substation3dCloned = true;
          if (Array.isArray(node.material)) {
            node.material[index] = cloned;
          } else {
            node.material = cloned;
          }
          material = cloned;
        }
        if (material.color) material.color.setHex(colorSet.color);
        if (material.emissive) {
          material.emissive.setHex(colorSet.emissive);
          material.emissiveIntensity = 0.9;
        }
      });
    });
  }

  applyHandleRotation(handle, objectName, rotationDegrees) {
    const base = this.originalRotations.get(objectName) ?? new THREE.Euler();
    handle.rotation.set(
      base.x + degreesToRadians(rotationDegrees.x ?? 0),
      base.y + degreesToRadians(rotationDegrees.y ?? 0),
      base.z + degreesToRadians(rotationDegrees.z ?? 0),
    );
  }

  renderCircuitList() {
    if (!this.circuitListNode) return;
    this.circuitListNode.innerHTML = this.config.circuits.map((circuit) => {
      const state = this.lastStates.get(circuit.circuitId) ?? { key: "unknown", sampleTime: null, quality: "unknown" };
      const bitMask = circuit.bitMask ? `0x${Number(circuit.bitMask).toString(16).padStart(4, "0")}` : "--";
      return `<article class="substation-3d-circuit ${state.key}">
        <div>
          <strong>${escapeHtml(circuit.name)}</strong>
          <span>${escapeHtml(circuit.circuitId)} / ${escapeHtml(circuit.meterId)} / ${escapeHtml(circuit.pointCode)} / ${bitMask}</span>
        </div>
        <em>${STATE_COPY[state.key] ?? STATE_COPY.unknown}</em>
      </article>`;
    }).join("");
  }

  reportModelStatus() {
    const missing = this.config.circuits.flatMap((circuit) => {
      const names = [];
      if (!this.objectIndex.has(circuit.lampObject)) names.push(circuit.lampObject);
      if (!this.objectIndex.has(circuit.handleObject)) names.push(circuit.handleObject);
      return names;
    });
    if (missing.length > 0) {
      this.setStatus(`模型已加载，但缺少对象：${missing.join("、")}`, true);
      return;
    }
    this.setStatus("");
  }

  resetCamera() {
    const cameraPosition = this.config.camera?.position ?? [3.2, 2.4, 5.2];
    const target = this.config.camera?.target ?? [0, 1.2, 0];
    this.camera.position.set(...cameraPosition);
    this.controls.target.set(...target);
    this.controls.update();
  }

  fitCameraToModel() {
    this.setPresetView("iso");
  }

  setPresetView(viewName) {
    if (!this.model) return;
    const box = this.visibleModelBox();
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 0.6);
    const distance = maxSize * 2.15;
    const view = viewName || "iso";
    const offsets = {
      front: new THREE.Vector3(0, 0.18, -1),
      side: new THREE.Vector3(1, 0.18, 0),
      top: new THREE.Vector3(0, 1, 0.001),
      iso: new THREE.Vector3(0.72, 0.48, -1),
    };
    const offset = offsets[view] ?? offsets.iso;
    const position = center.clone().add(offset.normalize().multiplyScalar(distance));
    this.camera.up.set(0, 1, 0);
    if (view === "top") this.camera.up.set(0, 0, -1);
    this.controls.target.copy(center);
    this.camera.position.copy(position);
    this.camera.near = Math.max(distance / 100, 0.01);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  visibleModelBox() {
    const box = new THREE.Box3();
    const childBox = new THREE.Box3();
    this.model.updateWorldMatrix(true, true);
    this.model.traverse((object) => {
      if (!object.visible || this.ignoredObjects.has(object.name) || !object.isMesh) return;
      childBox.setFromObject(object);
      if (!childBox.isEmpty()) box.union(childBox);
    });
    return box;
  }

  resize() {
    const rect = this.viewport.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  setStatus(text, isError = false) {
    if (!this.statusNode) return;
    this.statusNode.textContent = text;
    this.statusNode.hidden = !text;
    this.statusNode.classList.toggle("error", isError);
  }

  createFallbackCabinet() {
    const group = new THREE.Group();
    group.name = "AA1_FALLBACK_MODEL";

    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 3.2, 0.82),
      new THREE.MeshStandardMaterial({ color: 0xe8edf3, roughness: 0.64, metalness: 0.18 }),
    );
    shell.position.y = 1.6;
    shell.name = "AA1_CABINET_BODY";
    group.add(shell);

    const doorLineMaterial = new THREE.MeshStandardMaterial({ color: 0x596579, roughness: 0.5 });
    for (let index = 0; index < 4; index += 1) {
      const y = 2.66 - index * 0.72;
      const drawer = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.55, 0.045), doorLineMaterial.clone());
      drawer.position.set(0, y, 0.435);
      drawer.name = `AA1_C${index + 1}_DRAWER`;
      group.add(drawer);

      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 28, 16),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8, emissive: 0x334155, emissiveIntensity: 0.9 }),
      );
      lamp.position.set(-0.56, y + 0.08, 0.5);
      lamp.name = `AA1_C${index + 1}_LAMP`;
      group.add(lamp);

      const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.38, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.35, metalness: 0.2 }),
      );
      handle.position.set(0.54, y, 0.52);
      handle.name = `AA1_C${index + 1}_HANDLE`;
      group.add(handle);
    }

    return group;
  }
}

function degreesToRadians(value) {
  return (Number(value) || 0) * Math.PI / 180;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
