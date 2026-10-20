export function platformAssetBindings<T extends {filename:string}>(metadata:Record<string,any>,assets:T[],platform:string):Array<{asset:T;role:'cover'|'gallery_image';ordinal:number}>|null;
export function frozenPlatformAssets<T extends Record<string,any>>(canonical:Record<string,any>,assets:T[],platform:string):T[];
