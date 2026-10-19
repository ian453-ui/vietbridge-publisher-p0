import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Reuse this Mac's installed Python/Pillow. Missing decoder always blocks intake.
const python=existsSync('/Library/Frameworks/Python.framework/Versions/3.14/bin/python3')?'/Library/Frameworks/Python.framework/Versions/3.14/bin/python3':'python3';
const formats={'.png':'PNG','.jpg':'JPEG','.jpeg':'JPEG','.webp':'WEBP'},cache=new Map();
const decode=`import io,json,sys,warnings,resource
from PIL import Image,ImageFile
resource.setrlimit(resource.RLIMIT_CPU,(3,3))
Image.MAX_IMAGE_PIXELS=40000000
ImageFile.LOAD_TRUNCATED_IMAGES=False
warnings.simplefilter('error',Image.DecompressionBombWarning)
b=sys.stdin.buffer.read(20000001)
if not b or len(b)>20000000: raise ValueError('file limit')
with Image.open(io.BytesIO(b),formats=['PNG','JPEG','WEBP']) as im:
 fmt=im.format
 width,height=im.size
 frames=getattr(im,'n_frames',1)
 if width<=0 or height<=0 or width*height*frames>40000000: raise ValueError('pixel limit')
 im.verify()
with Image.open(io.BytesIO(b),formats=['PNG','JPEG','WEBP']) as im:
 for i in range(frames):
  im.seek(i)
  if im.width<=0 or im.height<=0 or im.width*im.height>40000000: raise ValueError('pixel limit')
  im.load()
print(json.dumps({'format':fmt,'width':width,'height':height,'frames':frames}))`;

export function validateImage(bytes,extension,declaration={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20000000||!formats[extension.toLowerCase()])throw Error('IMAGE_FORMAT_OR_SIZE_INVALID');
 const key=createHash('sha256').update(bytes).digest('hex')+extension.toLowerCase();let shape=cache.get(key);
 if(!shape){
  try{shape=JSON.parse(execFileSync(python,['-I','-B','-c',decode],{input:bytes,encoding:'utf8',timeout:5000,maxBuffer:8192,stdio:['pipe','pipe','pipe']}));}
  catch{throw Error('IMAGE_DECODE_INVALID_OR_RESOURCE_LIMIT');}
  if(shape.format!==formats[extension.toLowerCase()]||!Number.isSafeInteger(shape.width)||shape.width<1||!Number.isSafeInteger(shape.height)||shape.height<1||!Number.isSafeInteger(shape.frames)||shape.frames<1||shape.width*shape.height*shape.frames>40000000)throw Error('IMAGE_FORMAT_OR_DIMENSIONS_INVALID');
  shape=Object.freeze(shape);if(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(key,shape);
 }
 const pairs=[];
 if(declaration.primary_image_width!==undefined||declaration.primary_image_height!==undefined)pairs.push([declaration.primary_image_width,declaration.primary_image_height]);
 if(declaration.primary_image_dimensions!==undefined){const d=declaration.primary_image_dimensions;if(!d||Array.isArray(d)||typeof d!=='object')throw Error('IMAGE_DECLARED_DIMENSIONS_INVALID');pairs.push([d.width,d.height]);}
 for(const [width,height] of pairs)if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||width!==shape.width||height!==shape.height)throw Error('IMAGE_DECLARED_DIMENSIONS_MISMATCH');
 if(declaration.primary_image_format!==undefined&&declaration.primary_image_format!==shape.format)throw Error('IMAGE_DECLARED_FORMAT_MISMATCH');
 return shape;
}
