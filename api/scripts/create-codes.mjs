import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const amount = Number(process.argv[2] ?? 20);
if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw new Error('Укажи число кодов от 1 до 100.');
const target = resolve('.secrets');
try { await access(resolve(target, 'student-codes.csv')); throw new Error('Коды уже созданы. Для новой группы используй новую папку или сохрани старые файлы отдельно.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(target, { recursive: true });
const students = Array.from({ length: amount }, (_, index) => {
  const token = randomBytes(24).toString('base64url');
  return { id: 'team-' + String(index + 1).padStart(2, '0'), token, sha256: createHash('sha256').update(token).digest('hex') };
});
const registry = JSON.stringify({ version: 1, students: students.map(({id,sha256})=>({id,sha256})) });
await writeFile(resolve(target, 'student-codes.csv'), '\ufeffКоманда,Код доступа\n' + students.map(s => `${s.id},${s.token}`).join('\n') + '\n', {mode:0o600});
await writeFile(resolve(target, 'STUDENT_CODES_JSON.txt'), registry, {mode:0o600});
await writeFile(resolve(target, 'cloudflare-secrets.json'), JSON.stringify({STUDENT_CODES_JSON:registry}), {mode:0o600});
console.log(`Готово: ${amount} кодов в .secrets/student-codes.csv. Хеши для Cloudflare — .secrets/STUDENT_CODES_JSON.txt. Сами коды не напечатаны.`);
