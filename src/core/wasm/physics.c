#include <math.h>
#include <stdint.h>
#include <float.h>

// ABI order matches physics-wasm.js. Each instance owns one mesh's memory.
static double *P,*Q,*V,*W,*OX,*OY,*M,*IM,*K,*TX,*TY,*R,*SX,*SY,*A,*B,*C,*D,*J,*G,*H;
static uint16_t *ids;
static int32_t *offset,*adj;
static int32_t *adj_element;
static double *geometry;
static double *target_x,*target_y,*target_pin,*drive_col_x,*drive_col_y,*drive_row_x,*drive_row_y;
static float *target_weight;
static int target_stride;
static double *warm_geometry;
static int n,nt;
static double mu,lam,scale;
static int failed,searches,logs_saved,logs_evaluated;
static double minimum_j=1,maximum_j=1;
#define EXPORT(name) __attribute__((export_name(name)))

EXPORT("configure") void configure(uint32_t *p,int nodes,int elements){
  P=(double*)(uintptr_t)p[0];Q=(double*)(uintptr_t)p[1];V=(double*)(uintptr_t)p[2];W=(double*)(uintptr_t)p[3];
  OX=(double*)(uintptr_t)p[4];OY=(double*)(uintptr_t)p[5];M=(double*)(uintptr_t)p[6];IM=(double*)(uintptr_t)p[7];
  K=(double*)(uintptr_t)p[8];TX=(double*)(uintptr_t)p[9];TY=(double*)(uintptr_t)p[10];R=(double*)(uintptr_t)p[11];
  SX=(double*)(uintptr_t)p[12];SY=(double*)(uintptr_t)p[13];A=(double*)(uintptr_t)p[14];B=(double*)(uintptr_t)p[15];
  C=(double*)(uintptr_t)p[16];D=(double*)(uintptr_t)p[17];J=(double*)(uintptr_t)p[18];G=(double*)(uintptr_t)p[19];H=(double*)(uintptr_t)p[20];
  ids=(uint16_t*)(uintptr_t)p[21];offset=(int32_t*)(uintptr_t)p[22];adj=(int32_t*)(uintptr_t)p[23];n=nodes;nt=elements;
  adj_element=(int32_t*)(uintptr_t)p[24];geometry=(double*)(uintptr_t)p[25];
  warm_geometry=(double*)(uintptr_t)p[26];
}
EXPORT("material") void material(double shear,double bulk,double image_scale){mu=shear;lam=bulk;scale=image_scale;}
EXPORT("configure_targets") void configure_targets(double *x,double *y,double *pin,float *weight,
    double *cx,double *cy,double *rx,double *ry,int stride){
  target_x=x;target_y=y;target_pin=pin;target_weight=weight;
  drive_col_x=cx;drive_col_y=cy;drive_row_x=rx;drive_row_y=ry;target_stride=stride;
}
static void target_drive(int mode,int col,int row,double uniform_y,double *ax,double *ay){
  if(mode==3){*ax=drive_col_x[col];*ay=drive_row_y[row];}
  else if(mode==2){*ax=drive_row_x[row];*ay=uniform_y;}
  else if(mode==1){*ax=drive_row_x[row];*ay=drive_col_y[col];}
  else{*ax=drive_row_x[row]+drive_col_x[col];*ay=drive_col_y[col];}
}
EXPORT("normalize_targets") void normalize_targets(void){
  int k=0;
  for(;k<n;k++){TX[k]=(TX[k]/K[k]);TY[k]=(TY[k]/K[k]);}
}
EXPORT("targets") void targets(double h,double inv_h2,double friction,double amp,int mode,double uniform_y,int normalize,double angle_cos,double angle_sin){
  int col=0,row=0,k=0;
  const int rotate=angle_cos!=1||angle_sin!=0;
  for(;k<n;k++){
    double ax=0,ay=0;
    if(mode>=0){
      target_drive(mode,col,row,uniform_y,&ax,&ay);
      if(rotate){double x=ax,y=ay;ax=x*angle_cos-y*angle_sin;ay=x*angle_sin+y*angle_cos;}
      ax*=amp*target_weight[k];ay*=amp*target_weight[k];
      if(++col==target_stride){col=0;row++;}
    }
    // All intermediates use JS-compatible doubles and accumulation order.
    double mass=M[k],pin=target_pin[k];
    K[k]=(mass*(inv_h2+pin));
    TX[k]=(mass*((P[k]+h*V[k]*friction)*inv_h2+ax+pin*target_x[k]));
    TY[k]=(mass*((Q[k]+h*W[k]*friction)*inv_h2+ay+pin*target_y[k]));
    if(normalize){TX[k]=(TX[k]/K[k]);TY[k]=(TY[k]/K[k]);}
  }
}
EXPORT("refresh") double refresh(void){
  double lo=1,hi=1;
  for(int e=0;e<nt;e++){
    int a=ids[3*e],b=ids[3*e+1],c=ids[3*e+2],r=5*e;
    double ux=P[b]-P[a],uy=Q[b]-Q[a],vx=P[c]-P[a],vy=Q[c]-Q[a];
    A[e]=ux*R[r]+vx*R[r+2];B[e]=ux*R[r+1]+vx*R[r+3];
    C[e]=uy*R[r]+vy*R[r+2];D[e]=uy*R[r+1]+vy*R[r+3];
    J[e]=A[e]*D[e]-B[e]*C[e];lo=fmin(lo,J[e]);hi=fmax(hi,J[e]);
  }
  minimum_j=lo;maximum_j=hi;return lo;
}
EXPORT("max_j") double max_j(void){return maximum_j;}
EXPORT("min_j") double min_j(void){return minimum_j;}
EXPORT("objective") double objective(int cached,int refresh_cache){
  double energy=0,lo=1,hi=1;
  for(int k=0;k<n;k++)if(IM[k]){double x=P[k]-TX[k],y=Q[k]-TY[k];energy+=.5*K[k]*(x*x+y*y);}
  for(int e=0;e<nt;e++){
    int r=e*5;double a,b,c,d,j;
    if(cached){a=A[e];b=B[e];c=C[e];d=D[e];j=J[e];}
    else{
      int i=ids[3*e],ii=ids[3*e+1],iii=ids[3*e+2];
      double ux=P[ii]-P[i],uy=Q[ii]-Q[i],vx=P[iii]-P[i],vy=Q[iii]-Q[i];
      a=ux*R[r]+vx*R[r+2];b=ux*R[r+1]+vx*R[r+3];c=uy*R[r]+vy*R[r+2];d=uy*R[r+1]+vy*R[r+3];j=a*d-b*c;
      if(refresh_cache){A[e]=a;B[e]=b;C[e]=c;D[e]=d;J[e]=j;lo=fmin(lo,j);hi=fmax(hi,j);}
    }
    if(!(j>1e-9))return INFINITY;
    energy+=R[r+4]*(.5*mu*(a*a+b*b+c*c+d*d-2)-mu*log(j)+.5*lam*(j-1)*(j-1));
  }
  if(refresh_cache){minimum_j=lo;maximum_j=hi;}return energy;
}
// A/B/C/D/J must still contain the baseline state (no prior exact trial).
// Candidate geometry is scratch until the whole-mesh bound proves descent.
// Infeasible candidates are rejected exactly; other inconclusive candidates
// leave caches unchanged for the original energy comparison.
EXPORT("warm_bound") int warm_bound(void){
  double upper=0,magnitude=0,lo=1,hi=1;
  for(int k=0;k<n;k++)if(IM[k]){
    double x0=OX[k]-TX[k],y0=OY[k]-TY[k],x1=P[k]-TX[k],y1=Q[k]-TY[k];
    double old=.5*K[k]*(x0*x0+y0*y0),candidate=.5*K[k]*(x1*x1+y1*y1);
    upper+=candidate-old;magnitude+=fabs(candidate)+fabs(old);
  }
  for(int e=0;e<nt;e++){
    int i=ids[3*e],ii=ids[3*e+1],iii=ids[3*e+2],r=5*e;
    double ux=P[ii]-P[i],uy=Q[ii]-Q[i],vx=P[iii]-P[i],vy=Q[iii]-Q[i];
    double a=ux*R[r]+vx*R[r+2],b=ux*R[r+1]+vx*R[r+3],c=uy*R[r]+vy*R[r+2],d=uy*R[r+1]+vy*R[r+3],j=a*d-b*c,j0=J[e];
    // The exact objective returns Infinity for this same feasibility failure,
    // so it can never pass its strict candidate < baseline comparison.
    if(!(j>1e-9))return -1;
    if(!(j0>1e-9))return 0;
    double inv0=1/j0,s=(j-j0)*inv0;if(!(s>-1))return 0;
    double inv=s<0?1/(1+s):1,area=R[r+4];
    double elastic0=.5*mu*(A[e]*A[e]+B[e]*B[e]+C[e]*C[e]+D[e]*D[e]-2),elastic1=.5*mu*(a*a+b*b+c*c+d*d-2);
    double volume0=.5*lam*(j0-1)*(j0-1),volume1=.5*lam*(j-1)*(j-1);
    double barrier=mu*(-s+.5*s*s*inv*inv);
    upper+=area*((elastic1-elastic0)+barrier+(volume1-volume0));
    // |log j| <= j + 1/j for j>0. Include baseline/candidate scales
    // and a mesh-size-dependent margin for accumulated cancellation.
    magnitude+=area*(fabs(elastic0)+fabs(elastic1)+fabs(volume0)+fabs(volume1)+fabs(barrier)+mu*(j0+j+inv0*(1+inv)));
    warm_geometry[e]=a;warm_geometry[nt+e]=b;warm_geometry[2*nt+e]=c;warm_geometry[3*nt+e]=d;warm_geometry[4*nt+e]=j;
    lo=fmin(lo,j);hi=fmax(hi,j);
  }
  if(!(isfinite(magnitude)&&isfinite(upper)))return 0;
  double margin=128*(n+nt+1)*DBL_EPSILON*magnitude;
  if(!(upper+margin<0))return 0;
  for(int e=0;e<nt;e++){
    A[e]=warm_geometry[e];B[e]=warm_geometry[nt+e];C[e]=warm_geometry[2*nt+e];D[e]=warm_geometry[3*nt+e];J[e]=warm_geometry[4*nt+e];
  }
  minimum_j=lo;maximum_j=hi;return 1;
}
EXPORT("residual") double residual(void){
  int k=0;
  for(;k<n;k++){G[k]=K[k]*(P[k]-TX[k]);H[k]=K[k]*(Q[k]-TY[k]);}
  int e=0;
  for(;e<nt;e++){
    double pressure=lam*(J[e]-1)-mu/J[e],area=R[5*e+4];
    double p00=mu*A[e]+pressure*D[e],p01=mu*B[e]-pressure*C[e],p10=mu*C[e]-pressure*B[e],p11=mu*D[e]+pressure*A[e];
    for(int z=3*e;z<3*e+3;z++){int i=ids[z];double sx=SX[z],sy=SY[z];G[i]+=area*(p00*sx+p01*sy);H[i]+=area*(p10*sx+p11*sy);}
  }
  double sum=0,mass=0;
  for(k=0;k<n;k++)if(IM[k]){sum+=(G[k]*G[k]+H[k]*H[k])*IM[k];mass+=M[k];}
  return sqrt(sum/mass)*scale;
}
static void solve_vertex(int k){
  double stiffness=K[k],xx=P[k]-TX[k],yy=Q[k]-TY[k];
  int off=offset[k],end=offset[k+1];
  double jxs[12],jys[12],fxs[12],fys[12],dj[12],fi[12],gn[12];
  double gx=stiffness*xx,gy=stiffness*yy,hxx=stiffness,hyy=stiffness,hxy=0;
  for(int o=off;o<end;o++){
    int e=adj_element[o],r=o*4;double sx=geometry[r],sy=geometry[r+1],area=geometry[r+2],a=A[e],b=B[e],c=C[e],d=D[e],j=J[e];
    double jx=d*sx-c*sy,jy=a*sy-b*sx,fx=a*sx+b*sy,fy=c*sx+d*sy,gn=geometry[r+3];
    int z=o-off;jxs[z]=jx;jys[z]=jy;fxs[z]=fx;fys[z]=fy;
    double inv=1/j,pressure=lam*(j-1)-mu*inv,bulk=lam+mu*inv*inv;
    gx+=area*(mu*fx+pressure*jx);gy+=area*(mu*fy+pressure*jy);
    hxx+=area*(mu*gn+bulk*jx*jx);hyy+=area*(mu*gn+bulk*jy*jy);
    hxy+=area*bulk*jx*jy;
  }
  double det=hxx*hyy-hxy*hxy;
  if(!(det>0&&isfinite(det))){failed=1;return;}
  double dx=(-hyy*gx+hxy*gy)/det,dy=(hxy*gx-hxx*gy)/det;
  if(fabs(dx)+fabs(dy)<1e-13)return;
  double alpha=1,length=dx*dx+dy*dy,directional=gx*dx+gy*dy;
  for(int o=off;o<end;o++){
    int e=adj_element[o],z=o-off;
    dj[z]=jxs[z]*dx+jys[z]*dy;fi[z]=fxs[z]*dx+fys[z]*dy;gn[z]=geometry[o*4+3];
    if(dj[z]<0)alpha=fmin(alpha,.9*(J[e]-1e-9)/(-dj[z]));
  }
  alpha=fmax(0,alpha);int accepted=0;
  for(int trial=0;trial<12;trial++){
    if(trial==0){
      // Conservative Taylor bound for -log1p, with a roundoff margin.
      // A failed bound falls through to the exact energy test.
      double upper=stiffness*(alpha*(xx*dx+yy*dy)+.5*alpha*alpha*length),magnitude=fabs(upper);
      for(int o=off;o<end;o++){
        int e=adj_element[o],z=o-off;double j=J[e],q=alpha*dj[z],s=q/j,inv=s<0?1/(1+s):1,area=geometry[o*4+2];
        double elastic=mu*(alpha*fi[z]+.5*alpha*alpha*gn[z]*length);
        double barrier=mu*(-s+.5*s*s*inv*inv),volume=lam*((j-1)*q+.5*q*q);
        upper+=area*(elastic+barrier+volume);magnitude+=area*(fabs(elastic)+fabs(barrier)+fabs(volume));
      }
      if(isfinite(upper)&&upper+64*DBL_EPSILON*magnitude<=1e-4*alpha*directional+1e-15){
        accepted=1;logs_saved+=end-off;break;
      }
    }
    logs_evaluated+=end-off;
    double delta=stiffness*(alpha*(xx*dx+yy*dy)+.5*alpha*alpha*length);
    for(int o=off;o<end;o++){
      int e=adj_element[o],z=o-off;double j=J[e],q=alpha*dj[z];
      delta+=geometry[o*4+2]*(mu*(alpha*fi[z]+.5*alpha*alpha*gn[z]*length)-mu*log1p(q/j)+lam*((j-1)*q+.5*q*q));
    }
    if(isfinite(delta)&&delta<=1e-4*alpha*directional+1e-15){accepted=1;break;}
    alpha*=.5;searches++;
  }
  if(!accepted)return;
  double ux=alpha*dx,uy=alpha*dy;P[k]+=ux;Q[k]+=uy;
  for(int o=off;o<end;o++){
    int e=adj_element[o],z=o-off,r=o*4;double sx=geometry[r],sy=geometry[r+1];
    A[e]+=ux*sx;B[e]+=ux*sy;C[e]+=uy*sx;D[e]+=uy*sy;J[e]+=alpha*dj[z];
  }
}
EXPORT("sweep") int sweep(int backward){
  failed=0;searches=0;logs_saved=0;logs_evaluated=0;
  for(int kk=0;kk<n;kk++){int k=backward?n-1-kk:kk;if(IM[k])solve_vertex(k);}
  return failed;
}
EXPORT("line_searches") int line_searches(void){return searches;}
EXPORT("logs_saved") int get_logs_saved(void){return logs_saved;}
EXPORT("logs_evaluated") int get_logs_evaluated(void){return logs_evaluated;}
EXPORT("velocities") void velocities(double h){
  int k=0;
  for(;k<n;k++){V[k]=(P[k]-OX[k])/h;W[k]=(Q[k]-OY[k])/h;}
}
