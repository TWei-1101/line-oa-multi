import { existsSync } from 'node:fs'; import { spawn } from 'node:child_process';
import { multiDataPaths } from '../src/data-paths.js';
import { evaluateDowngrade } from './family-downgrade-preflight.js';
const {openclawDb:db}=multiDataPaths();
if(existsSync(db))evaluateDowngrade(db,{familyAware:true});
const child=spawn(process.execPath,[new URL('../src/multi-server.js',import.meta.url).pathname],{stdio:'inherit',env:process.env});child.on('exit',(code,signal)=>process.exitCode=code??(signal?1:0));
