import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticVideo} from './fixtures/synthetic-video.js';
import {validateVideo} from '../src/video-validation.js';

test('real synthetic video and audio fully decode, while semantic/browser QA stays pending',()=>{
 const result=validateVideo(syntheticVideo({audio:true}),'.mp4');assert.equal(result.level,'VIDEO_DECODED');assert.equal(result.decoded_frames,10);assert.equal(result.audio_decoded,true);assert.equal(result.playback_verified,false);assert.equal(result.subtitle_alignment_verified,false);
});
test('original fake MP4, truncated payload, wrong container and audio-only fail closed',()=>{
 const bytes=syntheticVideo();
 for(const [data,ext] of [[Buffer.from('Deliberately NOT a playable video: tests bytes-only boundary.'),'.mp4'],[bytes.subarray(0,bytes.length-300),'.mp4'],[bytes,'.webm'],[syntheticVideo({audioOnly:true}),'.mp4']])assert.throws(()=>validateVideo(data,ext),/VIDEO_/);
});
test('missing probe or decoder cannot silently downgrade to a hash-only pass',()=>{
 const bytes=syntheticVideo();for(const options of [{ffprobe:'/missing-v3-ffprobe'},{ffmpeg:'/missing-v3-ffmpeg'}])assert.throws(()=>validateVideo(bytes,'.mp4',options),/VIDEO_DECODER_UNAVAILABLE/);
});
