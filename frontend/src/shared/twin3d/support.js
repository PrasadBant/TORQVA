// WebGL 2 capability check, kept free of Three.js so the workspace can decide between the 3D viewport and the 2D drawing without loading the 3D code.
let cached;
export function webgl2Available() {
  if (cached !== undefined) return cached;
  try {
    if (typeof window === 'undefined' || typeof window.WebGL2RenderingContext === 'undefined') return (cached = false);
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();         // release the probe context at once
    cached = !!gl;
  } catch { cached = false; }
  return cached;
}
