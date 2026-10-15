import { DEFAULT_PARAMS } from './settings.js';
import { clamp, toColorRGB } from './math.js';

const vs=`#version 300 es
precision highp float;
layout(location=0) in vec2 a_position;
layout(location=1) in vec2 a_uv;
uniform vec2 u_screen,u_image,u_pan;
uniform float u_zoom;
out vec2 v_uv;
void main(){
vec2 s=(a_position-u_image*.5)*u_zoom+u_screen*.5+u_pan;
gl_Position=vec4(s.x/u_screen.x*2.-1.,1.-s.y/u_screen.y*2.,0.,1.);
v_uv=a_uv;
}`;
const fs=`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_imageTex,u_maskTex;
uniform float u_maskVisible,u_maskOpacity,u_maskStrengthView,u_pixelRatio;
uniform vec3 u_maskColor;
out vec4 outColor;
void main(){
vec4 c=texture(u_imageTex,v_uv); // premultiplied RGBA
if(u_maskVisible>.5){
  // Diagonal hatching keeps a readable spacing at any zoom or display density.
  float phase=fract((gl_FragCoord.x+gl_FragCoord.y)/(16.*u_pixelRatio));
  float band=abs(phase-.5);
  float stripe=1.-smoothstep(.12,.12+fwidth(band),band);
  vec4 field=texture(u_maskTex,v_uv);
  float strength=field.r;
  vec3 fieldColor=strength<.5
    ?mix(vec3(64.,140.,255.)/255.,vec3(255.,223.,81.)/255.,strength*2.)
    :mix(vec3(255.,223.,81.)/255.,vec3(255.,82.,102.)/255.,strength*2.-1.);
  vec3 baseColor=u_maskStrengthView>.5?fieldColor:u_maskColor;
  float visible=field.g;
  float m=visible*u_maskOpacity*mix(.48,.85,stripe);
  vec3 maskColor=mix(baseColor,baseColor*.32,stripe);
  // The painted field is visible independently of image alpha. Composite the
  // overlay in premultiplied form; empty/erased field coverage still adds nothing.
  c=vec4(maskColor*m+c.rgb*(1.-m),m+c.a*(1.-m));
}
outColor=c;
}`;
const backgroundFS=`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_imageTex;
out vec4 outColor;
void main(){outColor=texture(u_imageTex,v_uv);}`;
export class GLRenderer {
  constructor(canvas,preserve=false){
    this.canvas=canvas;
    this.gl=canvas.getContext('webgl2',{alpha:true,antialias:true,depth:false,stencil:false,
      powerPreference:'high-performance',preserveDrawingBuffer:preserve,premultipliedAlpha:true});
    if(!this.gl)throw Error('WebGL2 を初期化できませんでした。GPUが有効な対応ブラウザで開いてください。');
    const g=this.gl;
    this.program=this.makeProgram(vs,fs);
    this.vao=g.createVertexArray();this.vbo=g.createBuffer();this.uvbo=g.createBuffer();this.ibo=g.createBuffer();
    g.bindVertexArray(this.vao);
    g.bindBuffer(g.ARRAY_BUFFER,this.vbo);g.enableVertexAttribArray(0);g.vertexAttribPointer(0,2,g.FLOAT,false,0,0);
    g.bindBuffer(g.ARRAY_BUFFER,this.uvbo);g.enableVertexAttribArray(1);g.vertexAttribPointer(1,2,g.FLOAT,false,0,0);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER,this.ibo);g.bindVertexArray(null);
    this.texture=g.createTexture();this.maskTexture=g.createTexture();
    this.maskRevision=-1;this.vertexVersion=-1;this.filter=null;
    this.uni={};for(const name of ['u_screen','u_image','u_pan','u_zoom','u_maskVisible','u_maskOpacity','u_maskStrengthView','u_maskColor','u_pixelRatio','u_imageTex','u_maskTex'])
      this.uni[name]=g.getUniformLocation(this.program,name);
  }
  makeProgram(v,f){
    const g=this.gl;
    const compile=(src,type)=>{
      const sh=g.createShader(type);g.shaderSource(sh,src);g.compileShader(sh);
      if(!g.getShaderParameter(sh,g.COMPILE_STATUS)){const error=g.getShaderInfoLog(sh);g.deleteShader(sh);throw Error(error);}
      return sh;
    };
    const a=compile(v,g.VERTEX_SHADER),b=compile(f,g.FRAGMENT_SHADER),p=g.createProgram();
    g.attachShader(p,a);g.attachShader(p,b);g.linkProgram(p);g.deleteShader(a);g.deleteShader(b);
    if(!g.getProgramParameter(p,g.LINK_STATUS)){const error=g.getProgramInfoLog(p);g.deleteProgram(p);throw Error(error);}
    return p;
  }
  updateMesh(m){
    const g=this.gl;this.meshRef=m;this.indexCount=m.indices.length;this.vertexVersion=-1;
    g.bindVertexArray(this.vao);
    g.bindBuffer(g.ARRAY_BUFFER,this.vbo);g.bufferData(g.ARRAY_BUFFER,m.positions.byteLength,g.DYNAMIC_DRAW);
    g.bindBuffer(g.ARRAY_BUFFER,this.uvbo);g.bufferData(g.ARRAY_BUFFER,m.uv,g.STATIC_DRAW);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER,this.ibo);g.bufferData(g.ELEMENT_ARRAY_BUFFER,m.indices,g.STATIC_DRAW);g.bindVertexArray(null);
  }
  updateImage(image,mask,m,revision=0){
    this.updateMesh(m);this.filter=null;const g=this.gl;
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL,false);g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    const upload=(tex,source,mips)=>{
      g.bindTexture(g.TEXTURE_2D,tex);
      g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE);g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.LINEAR);
      g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,mips?g.LINEAR_MIPMAP_LINEAR:g.LINEAR);
      g.texImage2D(g.TEXTURE_2D,0,g.RGBA,g.RGBA,g.UNSIGNED_BYTE,source);
      if(mips)g.generateMipmap(g.TEXTURE_2D);
    };
    g.activeTexture(g.TEXTURE0);upload(this.texture,image,true);
    g.activeTexture(g.TEXTURE1);upload(this.maskTexture,mask,false);
    this.maskRevision=revision;
  }
  updateBackground(image){
    if(this.background?.image===image)return;
    const g=this.gl;
    if(!image){
      if(this.background){g.deleteTexture(this.background.texture);g.deleteVertexArray(this.background.vao);g.deleteBuffer(this.background.buffer);this.background=null;}
      return;
    }
    let b=this.background;
    if(!b){
      if(!this.backgroundProgram){this.backgroundProgram=this.makeProgram(vs,backgroundFS);this.backgroundUni={};for(const name of ['u_screen','u_image','u_pan','u_zoom','u_imageTex'])this.backgroundUni[name]=g.getUniformLocation(this.backgroundProgram,name);}
      b=this.background={texture:g.createTexture(),vao:g.createVertexArray(),buffer:g.createBuffer()};
      g.bindVertexArray(b.vao);g.bindBuffer(g.ARRAY_BUFFER,b.buffer);
      g.enableVertexAttribArray(0);g.vertexAttribPointer(0,2,g.FLOAT,false,16,0);
      g.enableVertexAttribArray(1);g.vertexAttribPointer(1,2,g.FLOAT,false,16,8);g.bindVertexArray(null);
    }
    b.image=image;b.width=b.height=0;b.filter=null;
    g.activeTexture(g.TEXTURE0);g.bindTexture(g.TEXTURE_2D,b.texture);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL,false);
    g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE);g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
    g.texImage2D(g.TEXTURE_2D,0,g.RGBA,g.RGBA,g.UNSIGNED_BYTE,image);g.generateMipmap(g.TEXTURE_2D);
  }
  ensureMask(mask,revision,rect){
    if(this.maskRevision===revision)return;
    const g=this.gl;g.activeTexture(g.TEXTURE1);g.bindTexture(g.TEXTURE_2D,this.maskTexture);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL,false);g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    if(this.maskRevision===revision-1&&rect){
      const x=clamp(Math.floor(rect.x),0,mask.width-1),y=clamp(Math.floor(rect.y),0,mask.height-1),
            x2=clamp(Math.ceil(rect.x2),x+1,mask.width),y2=clamp(Math.ceil(rect.y2),y+1,mask.height);
      const data=mask.getContext('2d',{willReadFrequently:true}).getImageData(x,y,x2-x,y2-y);
      g.texSubImage2D(g.TEXTURE_2D,0,x,y,g.RGBA,g.UNSIGNED_BYTE,data);
    }else g.texSubImage2D(g.TEXTURE_2D,0,0,0,g.RGBA,g.UNSIGNED_BYTE,mask);
    this.maskRevision=revision;
  }
  draw(m,screenW,screenH,zoomLevel,offsetX,offsetY,maskVisible=false,bg='transparent',options=DEFAULT_PARAMS,backgroundPosition=null){
    const g=this.gl;if(!g||!m||screenW<1||screenH<1)return;
    g.viewport(0,0,this.canvas.width,this.canvas.height);
    if(bg==='white')g.clearColor(.97,.97,.995,1);
    else if(bg==='dark')g.clearColor(.105,.12,.165,1);
    else g.clearColor(0,0,0,0);
    g.clear(g.COLOR_BUFFER_BIT);
    // The foreground remains one connected surface. An optional user-provided
    // background has its own quad behind it and can move independently.
    g.disable(g.DEPTH_TEST);g.disable(g.CULL_FACE);
    g.enable(g.BLEND);g.blendFunc(g.ONE,g.ONE_MINUS_SRC_ALPHA);
    g.useProgram(this.program);const u=this.uni;
    g.uniform2f(u.u_screen,screenW,screenH);g.uniform2f(u.u_image,m.w,m.h);
    g.uniform2f(u.u_pan,offsetX,offsetY);g.uniform1f(u.u_zoom,zoomLevel);
    g.uniform1f(u.u_maskVisible,maskVisible?1:0);g.uniform1f(u.u_maskOpacity,options.maskOpacity/100);
    g.uniform1f(u.u_maskStrengthView,options.maskView==='strength'?1:0);
    g.uniform1f(u.u_pixelRatio,this.canvas.width/screenW);
    const rgb=toColorRGB(options.maskColor);g.uniform3f(u.u_maskColor,...rgb);
    if(bg==='image'&&this.background){
      const b=this.background,bx=backgroundPosition?.x||0,by=backgroundPosition?.y||0,bs=backgroundPosition?.scale??1;
      if(b.width!==m.w||b.height!==m.h||b.x!==bx||b.y!==by||b.scale!==bs){
        // Keep the complete background quad, independent of foreground bounds.
        // The viewport (or export canvas) supplies the only clipping boundary.
        const scale=Math.max(m.w/b.image.width,m.h/b.image.height)*bs;
        const w=scale*b.image.width,h=scale*b.image.height,x=(m.w-w)/2+bx,y=(m.h-h)/2+by;
        g.bindBuffer(g.ARRAY_BUFFER,b.buffer);
        g.bufferData(g.ARRAY_BUFFER,new Float32Array([x,y,0,0,x+w,y,1,0,x,y+h,0,1,x+w,y+h,1,1]),g.STATIC_DRAW);
        b.width=m.w;b.height=m.h;b.x=bx;b.y=by;b.scale=bs;
      }
      g.useProgram(this.backgroundProgram);const bu=this.backgroundUni;
      g.uniform2f(bu.u_screen,screenW,screenH);g.uniform2f(bu.u_image,m.w,m.h);g.uniform2f(bu.u_pan,offsetX,offsetY);g.uniform1f(bu.u_zoom,zoomLevel);
      g.activeTexture(g.TEXTURE0);g.bindTexture(g.TEXTURE_2D,b.texture);g.uniform1i(bu.u_imageTex,0);
      if(b.filter!==options.renderMode){const pixel=options.renderMode==='nearest';g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,pixel?g.NEAREST:g.LINEAR);g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,pixel?g.NEAREST:g.LINEAR_MIPMAP_LINEAR);b.filter=options.renderMode;}
      g.bindVertexArray(b.vao);g.drawArrays(g.TRIANGLE_STRIP,0,4);g.useProgram(this.program);
    }
    g.activeTexture(g.TEXTURE0);g.bindTexture(g.TEXTURE_2D,this.texture);g.uniform1i(u.u_imageTex,0);
    if(this.filter!==options.renderMode){
      const pixel=options.renderMode==='nearest';
      g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,pixel?g.NEAREST:g.LINEAR);
      g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,pixel?g.NEAREST:g.LINEAR_MIPMAP_LINEAR);
      this.filter=options.renderMode;
    }
    g.activeTexture(g.TEXTURE1);g.bindTexture(g.TEXTURE_2D,this.maskTexture);g.uniform1i(u.u_maskTex,1);
    g.bindVertexArray(this.vao);
    if(this.vertexVersion!==m.version){
      m.buildVertices();g.bindBuffer(g.ARRAY_BUFFER,this.vbo);g.bufferSubData(g.ARRAY_BUFFER,0,m.positions);
      this.vertexVersion=m.version;
    }
    g.drawElements(g.TRIANGLES,this.indexCount,g.UNSIGNED_SHORT,0);g.bindVertexArray(null);
  }
  dispose(){
    const g=this.gl;if(!g)return;
    this.updateBackground(null);
    for(const tex of [this.texture,this.maskTexture])g.deleteTexture(tex);
    for(const b of [this.vbo,this.uvbo,this.ibo])g.deleteBuffer(b);
    g.deleteVertexArray(this.vao);g.deleteProgram(this.program);if(this.backgroundProgram)g.deleteProgram(this.backgroundProgram);this.gl=null;
  }
}
