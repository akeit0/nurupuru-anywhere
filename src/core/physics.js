import { clamp, TAU } from './math.js';
import { DEFAULT_PARAMS } from './settings.js';
import { attachWasm, DEFAULT_BACKEND } from './physics-wasm.js';

/*
 * nurupuru physics: 2D Neo-Hookean FEM + Vertex Block Descent.
 * Material W = mu/2 (||F||^2 - 2 - 2 ln J) + lambda/2 (J-1)^2, J>0.
 * In 2D this material's single-vertex Hessian is positive definite when
 * combined with inertia. We solve the 2x2 Newton system per vertex.
 * A feasible energy-decreasing line search is part of this solver.
 * VBD: https://ankachan.github.io/Projects/VertexBlockDescent/index.html
 * Small Steps (time-stepping motivation):
 * https://matthias-research.github.io/pages/publications/smallsteps.pdf
 */
export class SoftMesh {
  constructor(w,h,quality,backend=DEFAULT_BACKEND){
    this.requestedBackend=backend;this.backend='js';
    this.w=w; this.h=h; this.scale=Math.min(w,h);
    const target={eco:1100,balanced:2400,fine:4600}[quality]||1100;
    const aspect=w/h;
    this.cols=clamp(Math.round(Math.sqrt(target*aspect)),12,110);
    this.rows=clamp(Math.round(this.cols/aspect),12,110);
    this.n=(this.cols+1)*(this.rows+1);
    const n=this.n, stride=this.cols+1, L=this.scale;
    this.X=new Float64Array(n);this.Y=new Float64Array(n);
    this.px=new Float64Array(n);this.py=new Float64Array(n);
    this.vx=new Float64Array(n);this.vy=new Float64Array(n);
    this.oldX=new Float64Array(n);this.oldY=new Float64Array(n);
    this.weight=new Float32Array(n);this.mass=new Float64Array(n);this.invMass=new Float64Array(n);
    this.x0=new Float32Array(n);this.y0=new Float32Array(n);
    this.positions=new Float32Array(n*2);this.uv=new Float32Array(n*2);
    this.pinRate=new Float64Array(n);
    const ids=[];
    for(let j=0;j<=this.rows;j++)for(let i=0;i<=this.cols;i++){
      const k=j*stride+i;
      this.X[k]=w*i/this.cols/L;this.Y[k]=h*j/this.rows/L;
      this.x0[k]=this.X[k]*L;this.y0[k]=this.Y[k]*L;
      this.uv[k*2]=i/this.cols;this.uv[k*2+1]=j/this.rows;
    }
    // Alternate diagonals. No single preferred diagonal throughout the image.
    for(let j=0;j<this.rows;j++)for(let i=0;i<this.cols;i++){
      const a=j*stride+i,b=a+1,c=a+stride,d=c+1;
      if((i+j)&1)ids.push(a,b,d,a,d,c);
      else ids.push(a,b,c,b,d,c);
    }
    this.indices=new Uint16Array(ids);
    this.nt=ids.length/3;
    this.rest=new Float64Array(this.nt*5); // inverse Dm and rest area
    for(let e=0;e<this.nt;e++){
      const a=ids[e*3],b=ids[e*3+1],c=ids[e*3+2];
      const ux=this.X[b]-this.X[a],uy=this.Y[b]-this.Y[a],
            vx=this.X[c]-this.X[a],vy=this.Y[c]-this.Y[a],D=ux*vy-uy*vx,r=e*5,A=D*.5;
      this.rest[r]=vy/D;this.rest[r+1]=-vx/D;
      this.rest[r+2]=-uy/D;this.rest[r+3]=ux/D;this.rest[r+4]=A;
      this.mass[a]+=A/3;this.mass[b]+=A/3;this.mass[c]+=A/3;
    }
    for(let j=0;j<=this.rows;j++)for(let i=0;i<=this.cols;i++){
      const k=j*stride+i;
      this.invMass[k]=(i===0||i===this.cols||j===0||j===this.rows)?0:1/this.mass[k];
    }
    this.maskCenterX=w*.5;this.maskCenterY=h*.5;
    this.version=0;this.uploadVersion=-1;
    this.stats={minJ:1,maxJ:1,maxStretch:1,folds:0,cpuMS:0,retries:0,failed:false,
      solverIterations:0,solverResidual:0,solverTolerance:1,solverConverged:true,solverLimitHits:0};
    this.gripState=null;this.quiet=0;this.cacheKey='';
    this.reset();
  }
  reset(){
    this.px.set(this.X);this.py.set(this.Y);this.vx.fill(0);this.vy.fill(0);
    this.gripState=null;this.moving=false;this.energy=0;this.quiet=0;
    this.stats.minJ=this.stats.maxJ=this.stats.maxStretch=1;this.stats.folds=0;this.stats.failed=false;
    if(this.adj)this.refreshElements();
    this.version++;this.buildVertices();
  }
  sampleMask(ctx,mw,mh,rect=null){
    // App fields store movement in opaque red, independently of visibility.
    // Retain alpha masks for callers that supply ordinary selection canvases.
    const channel=ctx.canvas.dataset?.maskChannel==='red'?0:3;
    let cache=this.maskSamples;
    const reusable=cache&&cache.ctx===ctx&&cache.width===mw&&cache.height===mh&&cache.channel===channel;
    if(!reusable)cache=this.maskSamples={ctx,width:mw,height:mh,channel,values:new Float64Array(this.n)};
    let x1=0,y1=0,x2=mw,y2=mh;
    if(reusable&&rect){
      x1=clamp(Math.floor(rect.x),0,mw);y1=clamp(Math.floor(rect.y),0,mh);
      x2=clamp(Math.ceil(rect.x2),x1,mw);y2=clamp(Math.ceil(rect.y2),y1,mh);
    }
    const values=cache.values;
    // Sample the brush field over each finite-element node's footprint.
    // This is fixed input quadrature, not a motion-dependent edge filter.
    const rx=mw/this.cols*.24,ry=mh/this.rows*.24;
    // Include footprint corners, bilinear neighbour pixels and one grid-cell
    // margin for Float32 UV rounding. A new context/dimension/channel samples all.
    const partial=reusable&&rect;
    const i1=partial&&mw>1?clamp(Math.floor((x1-1-rx)/(mw-1)*this.cols)-1,0,this.cols):0;
    const i2=partial&&mw>1?clamp(Math.ceil((x2+rx)/(mw-1)*this.cols)+1,0,this.cols):this.cols;
    const j1=partial&&mh>1?clamp(Math.floor((y1-1-ry)/(mh-1)*this.rows)-1,0,this.rows):0;
    const j2=partial&&mh>1?clamp(Math.ceil((y2+ry)/(mh-1)*this.rows)+1,0,this.rows):this.rows;
    if(x2>x1&&y2>y1){
      // Read a halo containing every corner/neighbour of the affected nodes.
      // The canvas stays the pixel source; only node samples need a cache.
      const stride=this.cols+1;
      const left=clamp(Math.floor(this.uv[2*i1]*(mw-1)-rx),0,mw-1);
      const top=clamp(Math.floor(this.uv[2*j1*stride+1]*(mh-1)-ry),0,mh-1);
      const right=clamp(Math.floor(this.uv[2*i2]*(mw-1)+rx)+2,left+1,mw);
      const bottom=clamp(Math.floor(this.uv[2*j2*stride+1]*(mh-1)+ry)+2,top+1,mh);
      const width=right-left,height=bottom-top,data=ctx.getImageData(left,top,width,height).data;
      const at=(x,y)=>{
        x=clamp(x,0,mw-1)-left;y=clamp(y,0,mh-1)-top;
        const ix=Math.floor(x),iy=Math.floor(y),jx=Math.min(width-1,ix+1),jy=Math.min(height-1,iy+1),u=x-ix,v=y-iy;
        return ((data[(iy*width+ix)*4+channel]*(1-u)+data[(iy*width+jx)*4+channel]*u)*(1-v)
              +(data[(jy*width+ix)*4+channel]*(1-u)+data[(jy*width+jx)*4+channel]*u)*v)/255;
      };
      for(let j=j1;j<=j2;j++)for(let i=i1;i<=i2;i++){
        const k=j*stride+i,x=this.uv[2*k]*(mw-1),y=this.uv[k*2+1]*(mh-1);
        const v=(at(x-rx,y-ry)+at(x+rx,y-ry)+at(x-rx,y+ry)+at(x+rx,y+ry))*.25;
        this.weight[k]=v;values[k]=v;
      }
    }
    // Preserve the original double samples and summation order. Reducing the
    // Float32 weights or incrementally adjusting the centre changes drive phase.
    let sum=0,cx=0,cy=0;
    for(let k=0;k<this.n;k++){
      const v=values[k];sum+=v;cx+=v*this.x0[k];cy+=v*this.y0[k];
    }
    this.maskCenterX=sum?cx/sum:this.w/2;this.maskCenterY=sum?cy/sum:this.h/2;
    this.cacheKey='';this.moving=true;this.quiet=0;
  }
  maskAt(x,y){
    const gx=clamp(x/this.w*this.cols,0,this.cols-.00001),gy=clamp(y/this.h*this.rows,0,this.rows-.00001);
    const i=Math.floor(gx),j=Math.floor(gy),u=gx-i,v=gy-j,a=j*(this.cols+1)+i,b=a+1,c=a+this.cols+1,d=c+1,w=this.weight;
    return w[a]*(1-u)*(1-v)+w[b]*u*(1-v)+w[c]*(1-u)*v+w[d]*u*v;
  }
  pick(x,y){
    // Hit-test the deformed surface, not the original image coordinates.
    const qx=x/this.scale,qy=y/this.scale,P=this.px,Q=this.py,ids=this.indices;
    for(let e=0;e<this.nt;e++){
      const a=ids[e*3],b=ids[e*3+1],c=ids[e*3+2];
      const ux=P[b]-P[a],uy=Q[b]-Q[a],vx=P[c]-P[a],vy=Q[c]-Q[a],D=ux*vy-uy*vx;
      if(D<=1e-12)continue;
      const dx=qx-P[a],dy=qy-Q[a],u=(dx*vy-dy*vx)/D,v=(ux*dy-uy*dx)/D;
      if(u>=-1e-6&&v>=-1e-6&&u+v<=1.000001){
        const w=1-u-v;
        return {x:(w*this.X[a]+u*this.X[b]+v*this.X[c])*this.scale,
                y:(w*this.Y[a]+u*this.Y[b]+v*this.Y[c])*this.scale,
                weight:w*this.weight[a]+u*this.weight[b]+v*this.weight[c]};
      }
    }
    return null;
  }
  beginGrab(x,y,mode='grab',settings=DEFAULT_PARAMS){
    const hit=this.pick(x,y);if(!hit||hit.weight<.04)return false;
    const radius=settings.grabRadius/720,rx=hit.x/this.scale,ry=hit.y/this.scale;
    const ids=[],weights=[],ox=[],oy=[];
    for(let k=0;k<this.n;k++){
      if(!this.invMass[k]||this.weight[k]<.001)continue;
      const d2=((this.X[k]-rx)**2+(this.Y[k]-ry)**2)/(radius*radius);
      // Gaussian uses sigma = radius / 2 and keeps its natural weak outer tail.
      const falloff=settings.grabFalloff==='gaussian'?Math.exp(-2*d2):
        d2<1?(settings.grabFalloff==='linear'?1-d2:(1-d2)**2):0;
      const f=mode==='move'?this.weight[k]:falloff*this.weight[k];
      if(f<.0001)continue;
      ids.push(k);weights.push(f);ox.push(this.px[k]);oy.push(this.py[k]);
    }
    if(!ids.length)return false;
    this.gripState={ids:new Uint16Array(ids),weights:new Float64Array(weights),ox:new Float64Array(ox),oy:new Float64Array(oy),
      startX:x/this.scale,startY:y/this.scale,targetX:x/this.scale,targetY:y/this.scale};
    this.moving=true;this.stats.failed=false;return true;
  }
  grab(fromX,fromY,toX,toY){
    if(!this.gripState)return;
    this.gripState.targetX=toX/this.scale;this.gripState.targetY=toY/this.scale;this.moving=true;
  }
  // Camera acceleration acts as a fictitious inertia force in screen space.
  // Apply a velocity impulse to the *same* simulated vertices and let the
  // material solver produce the lag, recoil and oscillation. No grab target.
  applyViewAcceleration(deltaScreenVX,deltaScreenVY,zoom){
    const inv=1/(this.scale*Math.max(.05,zoom));
    const dvx=clamp(-deltaScreenVX*inv*.62,-1.9,1.9);
    const dvy=clamp(-deltaScreenVY*inv*.62,-1.9,1.9);
    if(Math.abs(dvx)+Math.abs(dvy)<.00001)return;
    for(let k=0;k<this.n;k++){
      if(!this.invMass[k])continue;
      const weight=this.weight[k];
      if(weight<.005)continue;
      const f=weight*weight*(3-2*weight); // material mobility, not a rigid translation
      this.vx[k]+=dvx*f;
      this.vy[k]+=dvy*f;
    }
    this.moving=true;this.quiet=0;
  }
  endGrab(){this.gripState=null;this.moving=true;this.quiet=0;}
  material(p){
    const key=[p.softness,p.areaKeep,p.returnSpeed,p.damping,p.anchor,p.grip].join(',');
    if(key===this.cacheKey)return;this.cacheKey=key;
    // Give firm/intermediate materials more slider travel, keeping 0 and 100.
    const hardness=Math.sqrt(1-p.softness/100);
    this.mu=.055*Math.exp(4*hardness+2.2*Math.pow(hardness,8));
    this.bulk=.18*Math.exp(p.areaKeep*.055);
    this.omega=TAU*(.35+p.returnSpeed*.022);
    this.damp=.035+9*(p.damping/100)**2;
    this.gripRate=(TAU*(1+p.grip*.035))**2;
    const outside=10**(2.4+p.anchor*.026),returnRate=this.omega*this.omega;
    // Interpolate compliance (inverse stiffness), preserving both endpoints.
    // Direct stiffness blending made mid/low uint8 values almost immovable.
    const fixedRate=returnRate+outside;
    for(let k=0;k<this.n;k++)this.pinRate[k]=returnRate*fixedRate/(returnRate+outside*this.weight[k]);
  }
  step(dt,t,p){
    this.material(p);
    const started=performance.now(),sub=clamp(Math.round(p.substeps||2),1,8),h=dt/sub;
    this.stats.solverIterations=0;this.stats.solverResidual=0;this.stats.solverTolerance=1;this.stats.solverConverged=true;
    for(let n=0;n<sub;n++)this.advance(h,t+n*h,p);
    this.version++;this.moving=true;
    let speed=0,displacement=0;
    for(let k=0;k<this.n;k++){
      speed=Math.max(speed,Math.abs(this.vx[k]),Math.abs(this.vy[k]));
      displacement=Math.max(displacement,Math.abs(this.px[k]-this.X[k]),Math.abs(this.py[k]-this.Y[k]));
    }
    this.energy=speed+displacement;
    if(!p.driveAuto&&!this.gripState&&speed*this.scale<.025&&displacement*this.scale<.008)this.quiet++;
    else this.quiet=0;
    if(this.quiet>12){this.reset();}
    this.stats.cpuMS=this.stats.cpuMS*.9+(performance.now()-started)*.1;
  }

  initVBD(){
    const n=this.n,nt=this.nt;
    this.f00=new Float64Array(nt);this.f01=new Float64Array(nt);this.f10=new Float64Array(nt);this.f11=new Float64Array(nt);
    this.jac=new Float64Array(nt);
    this.shapeX=new Float64Array(nt*3);this.shapeY=new Float64Array(nt*3);
    const lists=Array.from({length:n},()=>[]);
    for(let e=0;e<nt;e++){
      const r=e*5,R=this.rest,t=e*3;
      this.shapeX[t]=-R[r]-R[r+2];this.shapeY[t]=-R[r+1]-R[r+3];
      this.shapeX[t+1]=R[r];this.shapeY[t+1]=R[r+1];
      this.shapeX[t+2]=R[r+2];this.shapeY[t+2]=R[r+3];
      for(let k=0;k<3;k++)lists[this.indices[t+k]].push(t+k);
    }
    this.adjOffset=new Int32Array(n+1);
    for(let k=0;k<n;k++)this.adjOffset[k+1]=this.adjOffset[k]+lists[k].length;
    this.adj=new Int32Array(this.adjOffset[n]);
    for(let k=0;k<n;k++)this.adj.set(lists[k],this.adjOffset[k]);
    // Immutable [shapeX, shapeY, area, squaredShapeNorm] per incidence,
    // packed in vertex traversal order. Triangle state remains shared.
    this.adjElement=new Int32Array(this.adj.length);
    this.adjGeometry=new Float64Array(this.adj.length*4);
    for(let o=0;o<this.adj.length;o++){
      const v=this.adj[o],e=(v/3)|0,r=o*4,sx=this.shapeX[v],sy=this.shapeY[v];
      this.adjElement[o]=e;this.adjGeometry[r]=sx;this.adjGeometry[r+1]=sy;
      this.adjGeometry[r+2]=this.rest[e*5+4];this.adjGeometry[r+3]=sx*sx+sy*sy;
    }
    this.quadK=new Float64Array(n);this.targetX=new Float64Array(n);this.targetY=new Float64Array(n);
    this.gradientX=new Float64Array(n);this.gradientY=new Float64Array(n);
    this.tempDJ=new Float64Array(12);this.tempFI=new Float64Array(12);this.tempGN=new Float64Array(12);
    this.stats.lineSearch=0;this.stats.logSkipped=0;this.stats.logEvaluated=0;this.stats.failed=false;
    this.stats.warmBoundAttempts=0;this.stats.warmBoundAccepted=0;this.stats.warmBoundRejected=0;this.stats.warmObjectiveChecks=0;
    attachWasm(this,this.requestedBackend);
    this.refreshElements();
  }
  refreshElements(){
    const P=this.px,Q=this.py,ids=this.indices,R=this.rest,nt=this.nt,
      F00=this.f00,F01=this.f01,F10=this.f10,F11=this.f11,jac=this.jac;
    let minJ=1,maxJ=1;
    for(let e=0;e<nt;e++){
      const a=ids[3*e],b=ids[3*e+1],c=ids[3*e+2],r=e*5;
      const ux=P[b]-P[a],uy=Q[b]-Q[a],vx=P[c]-P[a],vy=Q[c]-Q[a];
      const f00=ux*R[r]+vx*R[r+2],f01=ux*R[r+1]+vx*R[r+3],
            f10=uy*R[r]+vy*R[r+2],f11=uy*R[r+1]+vy*R[r+3],J=f00*f11-f01*f10;
      F00[e]=f00;F01[e]=f01;F10[e]=f10;F11[e]=f11;jac[e]=J;
      minJ=Math.min(minJ,J);maxJ=Math.max(maxJ,J);
    }
    this.stats.minJ=minJ;this.stats.maxJ=maxJ;this.stats.folds=minJ>0?0:1;
  }
  objective(cached=false,refresh=false){
    const P=this.px,Q=this.py,K=this.quadK,TX=this.targetX,TY=this.targetY,invMass=this.invMass,
      ids=this.indices,R=this.rest,F00=this.f00,F01=this.f01,F10=this.f10,F11=this.f11,jac=this.jac,
      n=this.n,nt=this.nt,mu=this.mu,lam=this.bulk;
    let energy=0,minJ=1,maxJ=1;
    for(let k=0;k<n;k++){
      if(!invMass[k])continue;
      const dx=P[k]-TX[k],dy=Q[k]-TY[k];
      energy+=.5*K[k]*(dx*dx+dy*dy);
    }
    for(let e=0;e<nt;e++){
      const a=ids[3*e],b=ids[3*e+1],c=ids[3*e+2],r=e*5;
      let f00,f01,f10,f11,J;
      if(cached){f00=F00[e];f01=F01[e];f10=F10[e];f11=F11[e];J=jac[e];}
      else{
        const ux=P[b]-P[a],uy=Q[b]-Q[a],vx=P[c]-P[a],vy=Q[c]-Q[a];
        f00=ux*R[r]+vx*R[r+2];f01=ux*R[r+1]+vx*R[r+3];
        f10=uy*R[r]+vy*R[r+2];f11=uy*R[r+1]+vy*R[r+3];J=f00*f11-f01*f10;
        if(refresh){
          F00[e]=f00;F01[e]=f01;F10[e]=f10;F11[e]=f11;jac[e]=J;
          minJ=Math.min(minJ,J);maxJ=Math.max(maxJ,J);
        }
      }
      if(!(J>1e-9))return Infinity;
      energy+=R[r+4]*(.5*mu*(f00*f00+f01*f01+f10*f10+f11*f11-2)-mu*Math.log(J)+.5*lam*(J-1)**2);
    }
    if(refresh){this.stats.minJ=minJ;this.stats.maxJ=maxJ;this.stats.folds=minJ>0?0:1;}
    return energy;
  }
  residual(){
    // Mass-weighted RMS acceleration residual, in image pixels / second squared.
    // Assemble after a complete sweep; local pre-update gradients are not residuals.
    const G=this.gradientX,H=this.gradientY,K=this.quadK,P=this.px,Q=this.py,TX=this.targetX,TY=this.targetY,
      ids=this.indices,R=this.rest,F00=this.f00,F01=this.f01,F10=this.f10,F11=this.f11,jac=this.jac,
      SX=this.shapeX,SY=this.shapeY,invMass=this.invMass,masses=this.mass,n=this.n,nt=this.nt,mu=this.mu,lam=this.bulk;
    for(let k=0;k<n;k++){
      G[k]=K[k]*(P[k]-TX[k]);H[k]=K[k]*(Q[k]-TY[k]);
    }
    for(let e=0;e<nt;e++){
      const J=jac[e],pressure=lam*(J-1)-mu/J,A=R[e*5+4];
      const p00=mu*F00[e]+pressure*F11[e],p01=mu*F01[e]-pressure*F10[e],
        p10=mu*F10[e]-pressure*F01[e],p11=mu*F11[e]+pressure*F00[e];
      for(let z=3*e;z<3*e+3;z++){
        const k=ids[z],sx=SX[z],sy=SY[z];
        G[k]+=A*(p00*sx+p01*sy);H[k]+=A*(p10*sx+p11*sy);
      }
    }
    let sum=0,mass=0;
    for(let k=0;k<n;k++)if(invMass[k]){
      sum+=(G[k]*G[k]+H[k]*H[k])*invMass[k];mass+=masses[k];
    }
    return Math.sqrt(sum/mass)*this.scale;
  }
  warmStart(h){
    // One mass-preconditioned gradient step on the same implicit-Euler objective.
    // This reuses the assembled residual and includes inertia and all physical forces.
    const P=this.px,Q=this.py,OX=this.oldX,OY=this.oldY,G=this.gradientX,H=this.gradientY,
      invMass=this.invMass,n=this.n,h2=h*h;
    let displacement=0;
    for(let k=0;k<n;k++)if(invMass[k])displacement=Math.max(displacement,
      h2*Math.abs(G[k])*invMass[k],h2*Math.abs(H[k])*invMass[k]);
    if(displacement<1e-15)return false;
    let baseline,fraction=1,accepted=false;
    if(!this.warmStartBound){baseline=this.objective(true);this.stats.warmObjectiveChecks++;}
    // Initialization is optional; bound its cost as well as the solver sweeps.
    for(let trial=0;trial<2;trial++){
      for(let k=0;k<n;k++)if(invMass[k]){
        P[k]=OX[k]-fraction*h2*G[k]*invMass[k];Q[k]=OY[k]-fraction*h2*H[k]*invMass[k];
      }
      // Bounds leave original caches intact unless accepted. Once an exact
      // check refreshes them, later trials use the original exact comparison.
      if(baseline===undefined&&this.warmStartBound){
        this.stats.warmBoundAttempts++;
        const decision=this.warmStartBound();
        if(decision>0){this.stats.warmBoundAccepted++;accepted=true;break;}
        if(decision<0){this.stats.warmBoundRejected++;fraction*=.5;continue;}
      }
      if(baseline===undefined){
        // Cached objective uses current positions for the quadratic term.
        // Restore baseline positions before evaluating it, then reproduce
        // this trial's candidate with exactly the original arithmetic.
        P.set(OX);Q.set(OY);baseline=this.objective(true);this.stats.warmObjectiveChecks++;
        for(let k=0;k<n;k++)if(invMass[k]){
          P[k]=OX[k]-fraction*h2*G[k]*invMass[k];Q[k]=OY[k]-fraction*h2*H[k]*invMass[k];
        }
      }
      this.stats.warmObjectiveChecks++;
      if(this.objective(false,true)<baseline){accepted=true;break;}fraction*=.5;
    }
    if(!accepted){P.set(OX);Q.set(OY);this.refreshElements();}
    return accepted;
  }
  advance(h,t,p){
    if(!this.adj)this.initVBD();
    this.oldX.set(this.px);this.oldY.set(this.py);
    this.prepareTargets(h,t,p);
    const initialResidual=this.residual(),tolerance=Math.max(1,initialResidual*.001);
    this.warmStart(h);this.solveToTolerance(p,tolerance);
    this.sweep=(this.sweep||0)+1;
    this.updateVelocities(h);this.refreshElements();
  }
  prepareDrive(wave,preset){
    // x0/y0 are immutable rest coordinates of a regular grid. Evaluate the
    // original trigonometric arguments once per column/row, without angle
    // addition identities or altered per-vertex force arithmetic.
    let drive=this.driveCache;
    if(!drive){
      drive=this.driveCache={nx:new Float64Array(this.cols+1),ny:new Float64Array(this.rows+1),
        colX:new Float64Array(this.cols+1),colY:new Float64Array(this.cols+1),
        rowX:new Float64Array(this.rows+1),rowY:new Float64Array(this.rows+1)};
    }
    const cx=this.maskCenterX,cy=this.maskCenterY,width=this.w,height=this.h;
    if(drive.cx!==cx||drive.cy!==cy||drive.width!==width||drive.height!==height){
      for(let i=0;i<=this.cols;i++)drive.nx[i]=(this.x0[i]-cx)/width;
      for(let j=0;j<=this.rows;j++)drive.ny[j]=(this.y0[j*(this.cols+1)]-cy)/height;
      drive.cx=cx;drive.cy=cy;drive.width=width;drive.height=height;
    }
    const nx=drive.nx,ny=drive.ny,colX=drive.colX,colY=drive.colY,rowX=drive.rowX,rowY=drive.rowY;
    // Modes: summed row/column X, row X, uniform Y, or pulse axes.
    if(preset==='circle'||preset==='circle-reverse'){
      // A uniform rotating drive: right -> down is clockwise on the screen.
      drive.mode=2;drive.uniformY=Math.sin(wave)*(preset==='circle'?1:-1);
      rowX.fill(Math.cos(wave));
    }else if(preset==='pulse'){
      const sin=Math.sin(wave);drive.mode=3;
      for(let i=0;i<nx.length;i++)colX[i]=nx[i]*3*sin;
      for(let j=0;j<ny.length;j++)rowY[j]=ny[j]*3*sin;
    }else if(preset==='bounce'){
      drive.mode=2;drive.uniformY=Math.sin(wave)*.95+Math.sin(wave*2)*.18;
      for(let j=0;j<ny.length;j++)rowX[j]=Math.sin(wave+ny[j]*3)*.18;
    }else if(preset==='sway'){
      drive.mode=1;
      for(let j=0;j<ny.length;j++)rowX[j]=Math.sin(wave*.63+ny[j]*1.5);
      for(let i=0;i<nx.length;i++)colY[i]=Math.cos(wave*.53+nx[i])*.17;
    }else if(preset==='shake'){
      drive.mode=0;
      for(let j=0;j<ny.length;j++)rowX[j]=Math.sin(wave*2.4+ny[j]*7)*.65;
      for(let i=0;i<nx.length;i++){colX[i]=Math.sin(wave*4.1+nx[i]*6)*.25;colY[i]=Math.cos(wave*2.8+nx[i]*5)*.55;}
    }else throw Error(`Unknown motion preset: ${preset}`);
    return drive;
  }
  prepareTargets(h,t,p){
    const P=this.px,Q=this.py,V=this.vx,W=this.vy,n=this.n;
    const K=this.quadK,TX=this.targetX,TY=this.targetY,
      mass=this.mass,pinRate=this.pinRate,X=this.X,Y=this.Y,weights=this.weight;
    const invH2=1/(h*h),friction=Math.exp(-this.damp*h);
    const auto=p.driveAuto&&p.intensity>0, wave=TAU*(p.speed/100)*t;
    const drive=auto?this.prepareDrive(wave,p.preset):null;
    const angle=auto&&p.preset!=='pulse'?(p.driveAngle||0)*TAU/360:0;
    const angleCos=angle?Math.cos(angle):1,angleSin=angle?Math.sin(angle):0;
    // Convert the percentage of image width to short-edge-normalized physics units.
    // No hard motion cap: material energy and time stepping determine the result.
    const amp=(p.intensity/100)*(this.w/this.scale)*this.omega*this.omega;
    // Variational implicit Euler: inertia + material + attachment + finite grasp.
    // The inertia target retains the full velocity. Initialization and local
    // updates use the same energy and positive-J checks (docs/physics-solver.md).
    let col=0,row=0;
    for(let k=0;k<n;k++){
      let ax=0,ay=0;
      if(auto){
        if(drive.mode===3){ax=drive.colX[col];ay=drive.rowY[row];}
        else if(drive.mode===2){ax=drive.rowX[row];ay=drive.uniformY;}
        else if(drive.mode===1){ax=drive.rowX[row];ay=drive.colY[col];}
        else {ax=drive.rowX[row]+drive.colX[col];ay=drive.colY[col];}
        if(angle){const x=ax,y=ay;ax=x*angleCos-y*angleSin;ay=x*angleSin+y*angleCos;}
        ax*=amp*weights[k];ay*=amp*weights[k];
        if(++col>this.cols){col=0;row++;}
      }
      const m=mass[k],kr=pinRate[k];
      K[k]=m*(invH2+kr);
      TX[k]=m*((P[k]+h*V[k]*friction)*invH2+ax+kr*X[k]);TY[k]=m*((Q[k]+h*W[k]*friction)*invH2+ay+kr*Y[k]);
    }
    const g=this.gripState;
    if(g){
      const dx=g.targetX-g.startX,dy=g.targetY-g.startY;
      for(let z=0;z<g.ids.length;z++){
        const k=g.ids[z],stiffness=mass[k]*this.gripRate*g.weights[z];
        K[k]+=stiffness;TX[k]+=stiffness*(g.ox[z]+dx);TY[k]+=stiffness*(g.oy[z]+dy);
      }
    }
    for(let k=0;k<n;k++){TX[k]/=K[k];TY[k]/=K[k];}
  }
  updateVelocities(h){
    const P=this.px,Q=this.py,OX=this.oldX,OY=this.oldY,V=this.vx,W=this.vy,n=this.n;
    for(let k=0;k<n;k++){V[k]=(P[k]-OX[k])/h;W[k]=(Q[k]-OY[k])/h;}
  }
  sweepVertices(backward){
    const n=this.n,invMass=this.invMass;
    for(let kk=0;kk<n;kk++){
      const k=backward?n-1-kk:kk;
      if(invMass[k])this.solveVertex(k);
    }
  }
  solveToTolerance(p,tolerance){
    const maximum=clamp(Math.round(p.iterations||2),1,8);
    let residual=Infinity,sweeps=0;
    for(let iter=0;iter<maximum;iter++){
      const backward=((this.sweep||0)+iter)&1;
      this.sweepVertices(backward);
      sweeps++;
      residual=this.residual();if(residual<=tolerance)break;
    }
    this.stats.solverIterations=Math.max(this.stats.solverIterations,sweeps);
    if(residual/tolerance>this.stats.solverResidual/this.stats.solverTolerance){
      this.stats.solverResidual=residual;this.stats.solverTolerance=tolerance;
    }
    this.stats.solverConverged=this.stats.solverConverged&&residual<=tolerance;
    this.stats.solverLimitHits=(this.stats.solverLimitHits||0)+(residual>tolerance?1:0);
  }
  solveVertex(k){
    const P=this.px,Q=this.py,K=this.quadK[k],xx=P[k]-this.targetX[k],yy=Q[k]-this.targetY[k];
    const mu=this.mu,lam=this.bulk,off=this.adjOffset[k],end=this.adjOffset[k+1];
    const elements=this.adjElement,geometry=this.adjGeometry;
    let gx=K*xx,gy=K*yy,hxx=K,hyy=K,hxy=0;
    for(let o=off;o<end;o++){
      const e=elements[o],r=o*4,sx=geometry[r],sy=geometry[r+1],A=geometry[r+2];
      const a=this.f00[e],b=this.f01[e],c=this.f10[e],d=this.f11[e],J=this.jac[e];
      const jx=d*sx-c*sy,jy=a*sy-b*sx,fx=a*sx+b*sy,fy=c*sx+d*sy,gn=geometry[r+3];
      const invJ=1/J,pressure=lam*(J-1)-mu*invJ,bulkH=lam+mu*invJ*invJ;
      gx+=A*(mu*fx+pressure*jx);gy+=A*(mu*fy+pressure*jy);
      hxx+=A*(mu*gn+bulkH*jx*jx);hyy+=A*(mu*gn+bulkH*jy*jy);hxy+=A*bulkH*jx*jy;
    }
    const det=hxx*hyy-hxy*hxy;
    if(!(det>0&&Number.isFinite(det))){this.stats.failed=true;return;}
    const dx=(-hyy*gx+hxy*gy)/det,dy=(hxy*gx-hxx*gy)/det;
    if(Math.abs(dx)+Math.abs(dy)<1e-13)return;
    let alpha=1;
    const length2=dx*dx+dy*dy,directional=gx*dx+gy*dy;
    // In 2D, J varies linearly when one vertex moves. Thus the feasible
    // interval is computed exactly for every incident triangle.
    for(let o=off;o<end;o++){
      const e=elements[o],z=o-off,r=o*4,sx=geometry[r],sy=geometry[r+1];
      const a=this.f00[e],b=this.f01[e],c=this.f10[e],d=this.f11[e],J=this.jac[e];
      const dJ=(d*sx-c*sy)*dx+(a*sy-b*sx)*dy;
      this.tempDJ[z]=dJ;this.tempFI[z]=(a*sx+b*sy)*dx+(c*sx+d*sy)*dy;this.tempGN[z]=geometry[r+3];
      if(dJ<0)alpha=Math.min(alpha,.9*(J-1e-9)/(-dJ));
    }
    alpha=Math.max(0,alpha);
    let accepted=false;
    for(let trial=0;trial<12;trial++){
      if(trial===0){
        // For s > -1, -log1p(s) <= -s + s²/(2 min(1,1+s)²).
        // Accept only when this conservative energy bound passes Armijo;
        // otherwise evaluate the original logarithmic energy below.
        let upper=K*(alpha*(xx*dx+yy*dy)+.5*alpha*alpha*length2),magnitude=Math.abs(upper);
        for(let o=off;o<end;o++){
          const e=elements[o],z=o-off,J=this.jac[e],q=alpha*this.tempDJ[z],s=q/J;
          const inv=s<0?1/(1+s):1,A=geometry[o*4+2];
          const elastic=mu*(alpha*this.tempFI[z]+.5*alpha*alpha*this.tempGN[z]*length2);
          const barrier=mu*(-s+.5*s*s*inv*inv),volume=lam*((J-1)*q+.5*q*q);
          upper+=A*(elastic+barrier+volume);
          magnitude+=A*(Math.abs(elastic)+Math.abs(barrier)+Math.abs(volume));
        }
        if(Number.isFinite(upper)&&upper+64*Number.EPSILON*magnitude<=1e-4*alpha*directional+1e-15){
          accepted=true;this.stats.logSkipped+=end-off;break;
        }
      }
      this.stats.logEvaluated+=end-off;
      let delta=K*(alpha*(xx*dx+yy*dy)+.5*alpha*alpha*length2);
      for(let o=off;o<end;o++){
        const e=elements[o],z=o-off,J=this.jac[e],q=alpha*this.tempDJ[z];
        delta+=geometry[o*4+2]*(mu*(alpha*this.tempFI[z]+.5*alpha*alpha*this.tempGN[z]*length2)
          -mu*Math.log1p(q/J)+lam*((J-1)*q+.5*q*q));
      }
      if(Number.isFinite(delta)&&delta<=1e-4*alpha*directional+1e-15){accepted=true;break;}
      alpha*=.5;this.stats.lineSearch++;
    }
    if(!accepted)return;
    const ux=alpha*dx,uy=alpha*dy;
    P[k]+=ux;Q[k]+=uy;
    for(let o=off;o<end;o++){
      const e=elements[o],z=o-off,r=o*4,sx=geometry[r],sy=geometry[r+1];
      this.f00[e]+=ux*sx;this.f01[e]+=ux*sy;this.f10[e]+=uy*sx;this.f11[e]+=uy*sy;
      this.jac[e]+=alpha*this.tempDJ[z];
    }
  }
  buildVertices(){
    if(this.uploadVersion===this.version)return;
    // Direct rendering: exactly the positions solved above, with immutable UVs.
    for(let k=0;k<this.n;k++){this.positions[k*2]=this.px[k]*this.scale;this.positions[k*2+1]=this.py[k]*this.scale;}
    this.uploadVersion=this.version;
  }
  diagnostics(){
    let maxStretch=1;
    for(let e=0;e<this.nt;e++){
      const a=this.indices[e*3],b=this.indices[e*3+1],c=this.indices[e*3+2],r=e*5,R=this.rest;
      const ux=this.px[b]-this.px[a],uy=this.py[b]-this.py[a],vx=this.px[c]-this.px[a],vy=this.py[c]-this.py[a];
      const f00=ux*R[r]+vx*R[r+2],f01=ux*R[r+1]+vx*R[r+3],f10=uy*R[r]+vy*R[r+2],f11=uy*R[r+1]+vy*R[r+3];
      const I=f00*f00+f01*f01+f10*f10+f11*f11,J=f00*f11-f01*f10;
      maxStretch=Math.max(maxStretch,Math.sqrt((I+Math.sqrt(Math.max(0,I*I-4*J*J)))*.5));
    }
    this.stats.maxStretch=maxStretch;return {...this.stats,backend:this.backend,nodes:this.n,elements:this.nt};
  }
}
