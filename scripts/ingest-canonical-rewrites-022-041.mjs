import {resolve,join} from 'node:path';
import {ingestDocxContentBundle} from '../src/docx-content-ingestor.ts';

const ids={
  '022':'1KX1tusm7qzGO9oD-fDfaLJvd_Aa7njhh7WI0oexQcD4','023':'1SBK5uNv4TTG7p_ix7JltjbknBCZMzXV-uLOwm2TXozM','024':'1M6YaUdI3P4qOrPwg7BLK6IZpUOFnbgihaHcmfp2CPaE','025':'1WEJ9MSZCv0Gb7k4uFLqlKUZcpqUzbYnjqJNAChGNLY8',
  '026':'1i7KN9OWIIFAnp_N6LFEvc5coBhADH6w3cB1ffLrbRcg','027':'1o1wazG7tjqQJKSj2dr2OjfrSyUYZUqWoqdc94rIZ6fA','028':'1ltjji_xVY1DaPk6swBUns20VIf3A_S_Rq-w_rfowcq8','029':'1KFrBXq9ccenvQnc6uvXPoCbqqaTp3hJR9LNeE3X6ws4',
  '030':'11neFKIoNdrhTuzKbLxcxxd9g-0_InCU6CK7rKyMLNKc','031':'1KOWUYMmrLvPcSDkt0Sppzi3eoplkcd8DKl1G5eR2CbM','032':'1G4qXKRIUDNdPmTr0tkIx6QHH1CPoncBSsmTo-MdLPKU','033':'16X5BjgmyIyPgblRLxqlgCD9AuBCrfIbCGOPqC8mOeEY','034':'1qqzdyHyZ8s9NXt9Br6eyjcQCLLc4eM6hA2j8uLBzIb8','035':'13M1jrr5RLIgaFNbnYo3_ohjbV6_rU3tBfMJK0CXtex0',
  '036':'1311fMWFJukW1tFTcHWQ-61KCoULNTj7qNGEN10zJ_n0','037':'1YOArD1lbHw2ymvr7yIUfrt9J2RXzw_F93iDkAnmLPZ4','038':'19PYhchjypVaxKEse91YPtkMtT0k2InGHtcO1rV4hkJw','039':'1uXN4abi7EJvHi4Yo0QbEKJqTQNbW6Mtv7W_rMS--nN0','040':'1BSQGtQF5MgKoXz_KgU03N5Jthv4Ai6cTLPn4kg6zpIk','041':'10E676AYi8Ed9CQExeQ8zSxezZl5b64IcMjSHBW2pXIs'
};
const input=resolve(process.argv[2]||'input/canonical-rewrites-022-041');
const target=resolve(process.argv[3]||'../Content-Library/Canonical-Rewrites-022-041');
const imported=[];
for(const [suffix,driveFileId] of Object.entries(ids)){
  const result=ingestDocxContentBundle(join(input,`VBE-20260916-${suffix}.docx`),target,{driveFileId,driveFolderId:'0AOoan3oNoPrYUk9PVA',sourceUrl:`https://docs.google.com/document/d/${driveFileId}/edit`});
  if(result.imported.length!==1||result.imported[0].articleId!==`VBE-20260916-${suffix}`)throw new Error(`${suffix} did not materialize exactly once`);
  imported.push(result.imported[0]);
}
console.log(JSON.stringify({status:'PASS',input,target,imported:imported.length,items:imported},null,2));
