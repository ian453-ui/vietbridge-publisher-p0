import {readFileSync} from 'node:fs';
export const PNG=readFileSync(new URL('../fixtures/gpt-primary.png',import.meta.url));
export const JPEG=readFileSync(new URL('../fixtures/gpt-primary.jpg',import.meta.url));
export const WEBP=readFileSync(new URL('../fixtures/gpt-primary.webp',import.meta.url));
