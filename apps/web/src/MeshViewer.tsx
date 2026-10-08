import { useEffect, useId, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export type Point3D = [number, number, number];
export type Triangle = [Point3D, Point3D, Point3D];
export type MeshGeometry = { triangles: Triangle[]; sampled: boolean };

export default function MeshViewer({ fileName, geometry }: { fileName: string; geometry: MeshGeometry }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resetViewRef = useRef<() => void>(() => undefined);
  const instructionsId = useId();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!context) return;

    const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#eef0e9');
    const camera = new THREE.PerspectiveCamera(34, 2, 0.01, 10000);
    camera.up.set(0, 0, 1);

    const positions = new Float32Array(geometry.triangles.flat(2));
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const bufferGeometry = mergeVertices(sourceGeometry);
    sourceGeometry.dispose();
    bufferGeometry.computeVertexNormals();
    bufferGeometry.center();
    bufferGeometry.computeBoundingBox();
    bufferGeometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: '#78977c',
      metalness: 0.04,
      roughness: 0.72,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(bufferGeometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const radius = Math.max(bufferGeometry.boundingSphere?.radius ?? 1, 0.001);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 2.6, 64),
      new THREE.ShadowMaterial({ color: '#536058', opacity: 0.16 }),
    );
    floor.position.z = (bufferGeometry.boundingBox?.min.z ?? -radius) - radius * 0.03;
    floor.receiveShadow = true;
    scene.add(floor);

    scene.add(new THREE.HemisphereLight('#fffdf5', '#6f7f73', 1.1));
    const keyLight = new THREE.DirectionalLight('#fff8e8', 1.8);
    keyLight.position.set(radius * 2, radius * -2, radius * 3);
    keyLight.castShadow = true;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight('#c7d8c9', 0.8);
    rimLight.position.set(radius * -2, radius, radius);
    scene.add(rimLight);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = radius * 1.4;
    controls.maxDistance = radius * 8;
    controls.target.set(0, 0, 0);

    const resetView = () => {
      camera.position.set(radius * 1.7, radius * -2.2, radius * 1.45);
      camera.near = Math.max(radius / 100, 0.001);
      camera.far = radius * 20;
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
    };
    resetViewRef.current = resetView;
    resetView();

    const resize = () => {
      const width = canvas.clientWidth || 720;
      const height = canvas.clientHeight || 360;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    let frame = 0;
    const renderFrame = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(renderFrame);
    };
    renderFrame();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      bufferGeometry.dispose();
      material.dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      renderer.dispose();
      resetViewRef.current = () => undefined;
    };
  }, [geometry]);

  return (
    <figure className="mesh-viewer">
      <canvas
        aria-describedby={instructionsId}
        aria-label={`Interactive 3D preview of ${fileName}`}
        className="mesh-canvas"
        height={360}
        role="img"
        ref={canvasRef}
        width={720}
      />
      <div className="mesh-viewer-footer">
        <figcaption id={instructionsId}>
          Drag to rotate. Scroll or pinch to zoom.
          {geometry.sampled && <span> Uses optimized preview geometry.</span>}
        </figcaption>
        <button className="mesh-reset" onClick={() => resetViewRef.current()} type="button">Reset view</button>
      </div>
    </figure>
  );
}