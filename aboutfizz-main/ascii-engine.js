/* ASCII presentation engine v2 — inspired by referenceindex.html
   New in v2: cfg.centered (center block h+v like the ref), cfg.frame (draw box),
   cfg.warp (flow turbulence multiplier), cfg.rareEvery (seconds between rare msgs).
   Usage: AsciiBG({bg,color,glowColor,grad,atlas,speed,cellMin,cellMax,
                    banners:["FIZZ","FLUFF"],lines:[],glitch,glitchAggro,hueCycle,
                    centered,frame,rare,links,...}) */
window.AsciiBG=function(cfg){
const cv=document.getElementById('cv');cv.style.background=cfg.bg||'#000';
const ctx=cv.getContext('2d',{alpha:false});
const NOISE_ATLAS=cfg.atlas||" .'`,:^\";Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const GLITCH_CHARS="!@#$%^&*()_+-=[]{}|;:,./<>?~█▓▒░▄▀▌▐▀▄";
const GRAY=cfg.grad;
let W,H,CELL,cols,rows,textGridDirty=true,lastTime=0,lastProg=-1;
let renderText=[],phaseStart=performance.now()*.001,glitchFrames=0,rareFrames=0,rarePos=[],rareNext=0;
const TYPE_DUR=cfg.typeDur||6;
const FONT={F:["███████╗","██╔════╝","█████╗  ","██╔══╝  ","██║     ","╚═╝     "],
I:["██╗","██║","██║","██║","██║","╚═╝"],
Z:["███████╗","╚══███╔╝","  ███╔╝ "," ███╔╝  ","███████╗","╚══════╝"],
L:["██╗     ","██║     ","██║     ","██║     ","███████╗","╚══════╝"],
U:["██╗   ██╗","██║   ██║","██║   ██║","██║   ██║","╚██████╔╝"," ╚═════╝"]};
function wordArt(word){const out=[];for(let r=0;r<6;r++){let s="";for(const ch of word){s+=FONT[ch]?FONT[ch][r]:"    ";}out.push(s.replace(/\s+$/,""));}return out;}
function wrapped(){const L=[];(cfg.banners||[]).forEach(b=>{if(typeof b==="string"&&b.length<=12&&FONT[b[0]])L.push(...wordArt(b));else L.push(b);});L.push("");
for(const l of cfg.lines||[]){if(innerWidth<700&&l.length>40){let cur="";for(const w of l.split(' ')){if((cur+' '+w).trim().length<=40)cur=(cur?cur+' ':'')+w;else{if(cur)L.push(cur);cur=w;}}if(cur)L.push(cur);}else L.push(l);}
while(L.length&&L[L.length-1]==="")L.pop();return L;}
let LINES=[];
function resize(){W=cv.width=innerWidth*devicePixelRatio;H=cv.height=innerHeight*devicePixelRatio;
cv.style.width='100vw';cv.style.height='100vh';
LINES=wrapped();const maxLen=Math.max(...LINES.map(l=>l.length),10);const th=LINES.length+(cfg.frame?4:0);
const cw=Math.floor((W-16)/maxLen),ch=Math.floor((H-40)/th);
CELL=Math.max(cfg.cellMin||6,Math.min(cfg.cellMax||15,Math.min(cw,ch)));
cols=Math.max(1,Math.floor(W/CELL));rows=Math.max(1,Math.floor(H/CELL));
ctx.font=`${CELL}px monospace`;ctx.textBaseline='middle';ctx.textAlign='center';textGridDirty=true;}
addEventListener('resize',resize);resize();
const WARP=cfg.warp??1;
function flow(x,y,t){return{x:Math.sin(y*.011+t*.8)*22*Math.cos(t*.31)*WARP,y:Math.cos(x*.013-t*.6)*22*Math.sin(t*.27)*WARP};}
function noise(x,y,t){const v=Math.sin(x*.007+t)+Math.sin(y*.009-t*1.3)+Math.sin((x+y)*.005+t*.5)+Math.sin(Math.hypot(x-W/2,y-H/2)*.004-t);return Math.tanh(v/2.2)*.5+.5;}
function lerp(a,b,f){return a+(b-a)*f;}
function buildGrid(prog){renderText=[];const total=LINES.length;const shown=Math.ceil(total*prog);
const blockH=total+(cfg.frame?4:0);const top=Math.max(0,Math.floor((rows-blockH)/2));
for(let gy=0;gy<rows;gy++){
if(cfg.frame&&(gy===top||gy===top+blockH-1)){const row=[];for(let gx=0;gx<cols;gx++)row.push({char:'═',isText:true});renderText.push(row);continue;}
if(cfg.frame&&gy<top||gy>top+blockH-1||(cfg.frame&&gy>top&&gy<top+blockH-1&&(gy-top===1||false))){}
const li=gy-(cfg.frame?2:0)-top;if(li<0||li>=total){renderText.push(new Array(cols).fill(null).map(()=>({char:' ',isText:false})));continue;}
let line=(li<shown)?(LINES[li]||''):'';
if(li===shown-1&&prog<1){line=line.slice(0,Math.ceil(line.length*Math.min(1,(total*prog%1)*3)));}
let off=cfg.centered?Math.max(0,Math.floor((cols-line.length)/2)):(cfg.frame?4:0);
const row=[];for(let gx=0;gx<cols;gx++){const i=gx-off;const c=(i>=0&&i<line.length)?line[i]:' ';
if(cfg.frame&&(gx===off-3||gx===off+line.length+2))row.push({char:'║',isText:false});else row.push({char:c,isText:c!==' '});}
renderText.push(row);}textGridDirty=false;}
function curProg(){return Math.min(1,(performance.now()*.001-phaseStart)/TYPE_DUR);}
function glitch(dt){if(glitchFrames>0){glitchFrames-=dt*60;if(glitchFrames<=0)textGridDirty=true;return;}
if(!cfg.glitch)return;if(Math.random()<dt*(cfg.glitchAggro||.25)){textGridDirty=true;buildGrid(curProg());
const gy=2+Math.floor(Math.random()*Math.max(1,LINES.length-2));if(!renderText[gy])return;
const segs=[];let st=-1;for(let gx=0;gx<cols;gx++){if(renderText[gy][gx].isText){if(st<0)st=gx;}else if(st>=0){segs.push([st,gx-1]);st=-1;}}if(st>=0)segs.push([st,cols-1]);
if(!segs.length)return;const s=segs[Math.random()*segs.length|0];const len=Math.max(1,Math.floor((s[1]-s[0]+1)*(.5+Math.random()*.5)));
glitchFrames=25+Math.random()*70;for(let i=0;i<len;i++){const gx=s[0]+i;if(gx<cols)renderText[gy][gx].char=GLITCH_CHARS[Math.random()*GLITCH_CHARS.length|0];}}}
function spawnRare(){const msgs=cfg.rare||[];if(!msgs.length)return;textGridDirty=true;buildGrid(1);
const ys=[];for(let gy=0;gy<rows;gy++){for(let gx=0;gx<cols;gx++){if(renderText[gy][gx].isText){ys.push(gy);break;}}}
if(!ys.length)return;const gy=ys[Math.random()*ys.length|0];const msg=msgs[Math.random()*msgs.length|0];
rareFrames=200;rarePos=[];const sx=Math.max(0,Math.floor((cols-msg.length)/2));
for(let i=0;i<msg.length;i++){const gx=sx+i;if(gx<cols)rarePos.push({gx,gy,ch:msg[i]});}}
function frame(ms){const t=ms*.001;const dt=t-(lastTime||t);lastTime=t;
const ft=t*(cfg.speed??1);const wt=ft+Math.sin(ft*.101)*2;
const prog=curProg();if(Math.abs(prog-lastProg)>.002){textGridDirty=true;lastProg=prog;}
if(textGridDirty)buildGrid(prog);
glitch(dt);if(rareFrames>0)rareFrames-=dt*60;else{rareNext-=dt;if(rareNext<=0){spawnRare();rareNext=cfg.rareEvery||240+Math.random()*240;}}
ctx.fillStyle=cfg.bg||'#000';ctx.fillRect(0,0,W,H);
const hueShift=cfg.hueCycle?t*cfg.hueCycle:0;
for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){
const px=gx*CELL,py=gy*CELL;const tc=renderText[gy]?renderText[gy][gx]:null;
let ch=null,isTxt=false;
if(tc&&tc.isText&&tc.char!==' '){ch=tc.char;isTxt=true;}
else if(tc&&tc.isText&&tc.char==='═'){ch='═';}
else if(rareFrames>0){for(const rp of rarePos)if(rp.gx===gx&&rp.gy===gy){ch=rp.ch;isTxt=true;break;}}
ctx.font=`${CELL}px monospace`;
if(ch!==null){ctx.fillStyle=isTxt?(cfg.color||'#fff'):(cfg.frameColor||cfg.color||'#fff');
ctx.shadowBlur=isTxt?(cfg.glowBlur??8):6;ctx.shadowColor=isTxt?(cfg.glowColor||cfg.color||'#fff'):(cfg.glowColor||'#fff');
ctx.fillText(ch,px+CELL/2,py+CELL/2);ctx.shadowBlur=0;}
else{const f1=flow(px,py,wt),f2=flow(px+f1.x,py+f1.y,wt+1.5);
const sx=px+f1.x+f2.x*.7,sy=py+f1.y+f2.y*.7;const b=noise(sx,sy,wt*.6);
const gi=Math.min(GRAY.length-1,Math.max(0,Math.floor(b*(GRAY.length-1))));const c=GRAY[gi];
let col=`rgb(${c[0]|0},${c[1]|0},${c[2]|0})`;
if(hueShift){col=`hsl(${hueShift+b*90} 60% ${18+b*38}%)`}
ctx.shadowBlur=b>.75?(cfg.noiseGlow??3):0;ctx.shadowColor=col;ctx.fillStyle=col;
ctx.fillText(NOISE_ATLAS[Math.min(NOISE_ATLAS.length-1,Math.floor(b*(NOISE_ATLAS.length-1)))],px+CELL/2,py+CELL/2);ctx.shadowBlur=0;}}
requestAnimationFrame(frame);}
requestAnimationFrame(frame);
if(cfg.links){const d=document.createElement('div');d.id='ascii-links';
d.style.cssText='position:fixed;bottom:12px;left:0;right:0;text-align:center;font-family:monospace;font-size:14px;z-index:5';
d.innerHTML=cfg.links.map(l=>`<a href="${l[1]}" target="_blank" style="color:${cfg.color||'#fff'};opacity:.8;margin:0 16px;text-decoration:none;border-bottom:1px dashed currentColor">${l[0]}</a>`).join('');
document.body.appendChild(d);}
};
