import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Same seq binary as S5, outside ConPTY; bash's builtin time excludes shell startup. */
export async function measureProducer(out) {
  const file = join(out, 'S5-producer-controls.json');
  const seq = 'C:/Program Files/Git/usr/bin/seq.exe';
  const hash = createHash('sha256').update(readFileSync(seq)).digest('hex');
  const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
    : { seq, binarySha256:hash, samples:[], method:'bash --noprofile --norc; builtin time around seq only; /dev/null and regular file; 10 each' };
  if (report.binarySha256 !== hash) throw new Error('seq changed within producer results');
  for (const mode of ['null', 'file']) {
    for (let i=report.samples.filter(row=>row.mode===mode).length;i<10;i++) {
      const destination = mode === 'null' ? '/dev/null' : join(out, `producer-seq-${i+1}.txt`).replaceAll('\\','/');
      if (destination.includes("'")) throw new Error('Producer path contains a shell quote');
      const started = performance.now();
      const timing = await new Promise((resolve, reject) => {
        const child = spawn('C:/Program Files/Git/bin/bash.exe', ['--noprofile','--norc','-c',
          `TIMEFORMAT='%R'; { time '${seq}' 1 200000 > '${destination}'; }`], {cwd:out,windowsHide:true});
        let stderr=''; child.stderr.setEncoding('utf8'); child.stderr.on('data',chunk=>stderr+=chunk);
        child.stdout.resume(); child.on('error',reject);
        child.on('exit',code=>code===0?resolve(stderr.trim()):reject(new Error(`seq exit ${code}: ${stderr}`)));
      });
      const seconds = Number(timing);
      if (!Number.isFinite(seconds)) throw new Error('Unexpected builtin time output: '+timing);
      report.samples.push({mode,run:i+1,producerMs:seconds*1000,includingShellMs:performance.now()-started,
        destination,bytes:mode==='file'?readFileSync(destination).length:null,at:new Date().toISOString()});
      writeFileSync(file,JSON.stringify(report,null,2)+'\n','utf8');
    }
  }
  return report;
}
