import { binaries, PHYSICS_BACKENDS } from './physics-backends.js';
export { PHYSICS_BACKENDS, DEFAULT_BACKEND } from './physics-backends.js';

const modules = new Map();
// Only immutable modules are shared. Every mesh gets its own instance/memory.
function compile(backend) {
  if (!modules.has(backend)) {
    const bytes = Uint8Array.from(atob(binaries[backend]), c => c.charCodeAt(0));
    modules.set(backend, new WebAssembly.Module(bytes));
  }
  return modules.get(backend);
}
const fields = ['px','py','vx','vy','oldX','oldY','mass','invMass','quadK','targetX','targetY',
  'rest','shapeX','shapeY','f00','f01','f10','f11','jac','gradientX','gradientY','indices','adjOffset','adj','adjElement','adjGeometry'];

export function attachWasm(mesh, requested) {
  if (requested === 'js') return;
  if (!PHYSICS_BACKENDS.includes(requested)) throw Error(`Unknown physics backend: ${requested}`);
  let instance;
  try { instance=new WebAssembly.Instance(compile('wasm-scalar')); }
  catch { mesh.backend='js';return; }
  const api = instance.exports;
  mesh.warmGeometry=new Float64Array(mesh.nt*5);
  mesh.driveColX=mesh.driveCache?.colX||new Float64Array(mesh.cols+1);mesh.driveColY=mesh.driveCache?.colY||new Float64Array(mesh.cols+1);
  mesh.driveRowX=mesh.driveCache?.rowX||new Float64Array(mesh.rows+1);mesh.driveRowY=mesh.driveCache?.rowY||new Float64Array(mesh.rows+1);
  const targetFields=['X','Y','pinRate','weight','driveColX','driveColY','driveRowX','driveRowY'];
  const instanceFields=[...fields,'warmGeometry',...targetFields];
  let cursor = Number(api.__heap_base.value);
  const tableOffset = cursor;cursor += instanceFields.length * 4;
  const layout = instanceFields.map(name => {
    cursor = Math.ceil(cursor / 16) * 16;
    const previous = mesh[name];
    const Type = previous.constructor;
    const offset = cursor;cursor += previous.length * Type.BYTES_PER_ELEMENT;
    return { name, offset, previous, Type };
  });
  const needed = Math.ceil(cursor / 65536);
  const current = api.memory.buffer.byteLength / 65536;
  if (needed > current) api.memory.grow(needed - current);
  const table = new Uint32Array(api.memory.buffer, tableOffset, instanceFields.length);
  for (let i = 0; i < layout.length; i++) {
    const { name, offset, previous, Type } = layout[i];table[i] = offset;
    const view = new Type(api.memory.buffer, offset, previous.length);
    view.set(previous);mesh[name] = view;
  }
  if(mesh.driveCache)Object.assign(mesh.driveCache,{colX:mesh.driveColX,colY:mesh.driveColY,rowX:mesh.driveRowX,rowY:mesh.driveRowY});
  api.configure(tableOffset, mesh.n, mesh.nt);
  api.configure_targets(mesh.X.byteOffset,mesh.Y.byteOffset,mesh.pinRate.byteOffset,mesh.weight.byteOffset,
    mesh.driveColX.byteOffset,mesh.driveColY.byteOffset,mesh.driveRowX.byteOffset,mesh.driveRowY.byteOffset,mesh.cols+1);
  mesh.backend = 'wasm-scalar';
  const material = () => api.material(mesh.mu, mesh.bulk, mesh.scale);
  mesh.refreshElements = () => {
    mesh.stats.minJ = api.refresh();mesh.stats.maxJ = api.max_j();mesh.stats.folds = mesh.stats.minJ > 0 ? 0 : 1;
  };
  mesh.objective = (cached = false, refresh = false) => {
    material();const energy=api.objective(+cached,+refresh);
    if(refresh&&Number.isFinite(energy)){
      mesh.stats.minJ=api.min_j();mesh.stats.maxJ=api.max_j();mesh.stats.folds=mesh.stats.minJ>0?0:1;
    }
    return energy;
  };
  mesh.warmStartBound=()=>{
    material();const accepted=api.warm_bound();
    if(accepted>0){mesh.stats.minJ=api.min_j();mesh.stats.maxJ=api.max_j();mesh.stats.folds=mesh.stats.minJ>0?0:1;}
    return accepted;
  };
  mesh.residual = () => { material();return api.residual(); };
  mesh.sweepVertices = backward => {
    material();if (api.sweep(+!!backward)) mesh.stats.failed = true;
    mesh.stats.lineSearch += api.line_searches();
    mesh.stats.logSkipped += api.logs_saved();
    mesh.stats.logEvaluated += api.logs_evaluated();
  };
  mesh.updateVelocities = h => api.velocities(h);
  const prepareDrive=mesh.prepareDrive;
  mesh.prepareDrive=(wave,preset)=>{
    if(!mesh.driveCache)mesh.driveCache={nx:new Float64Array(mesh.cols+1),ny:new Float64Array(mesh.rows+1),
      colX:mesh.driveColX,colY:mesh.driveColY,rowX:mesh.driveRowX,rowY:mesh.driveRowY};
    return prepareDrive.call(mesh,wave,preset);
  };
  mesh.prepareTargets=(h,t,p)=>{
    const invH2=1/(h*h),friction=Math.exp(-mesh.damp*h);
    const auto=p.driveAuto&&p.intensity>0,wave=2*Math.PI*(p.speed/100)*t;
    // Use the JS trigonometry, writing its small row/column tables
    // straight into native memory. No per-tick copies of node-sized arrays.
    const drive=auto?mesh.prepareDrive(wave,p.preset):null;
    const angle=auto&&p.preset!=='pulse'?(p.driveAngle||0)*(2*Math.PI)/360:0;
    const amp=(p.intensity/100)*(mesh.w/mesh.scale)*mesh.omega*mesh.omega,g=mesh.gripState;
    api.targets(h,invH2,friction,amp,drive?drive.mode:-1,drive?.uniformY??0,g?0:1,angle?Math.cos(angle):1,angle?Math.sin(angle):0);
    if(g){
      // Grasp weights/positions remain JS doubles and can change independently.
      const K=mesh.quadK,TX=mesh.targetX,TY=mesh.targetY,dx=g.targetX-g.startX,dy=g.targetY-g.startY;
      for(let z=0;z<g.ids.length;z++){
        const k=g.ids[z],stiffness=mesh.mass[k]*mesh.gripRate*g.weights[z];
        K[k]+=stiffness;TX[k]+=stiffness*(g.ox[z]+dx);TY[k]+=stiffness*(g.oy[z]+dy);
      }
      api.normalize_targets();
    }
  };
}
