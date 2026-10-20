// Publisher protocol: @codearts/plugin-packager and Huawei Cloud's
// UploadFilePublisher, ShowExtensionTestingResult, PublishExtension APIs.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const token = process.env.CART_SECRET;
if (!token) throw new Error('CART_SECRET is required');
const path = process.argv[2];
if (!path?.endsWith('.carts')) throw new Error('Provide a .carts package');
const api = 'https://cloudide.cn-north-4.myhuaweicloud.com/';
async function request(route, options = {}) {
    const response = await fetch(new URL(route, api), {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
        headers: { ...options.headers, 'x-publisher-token': token },
    });
    if (!response.ok) throw new Error(`Huawei request failed: HTTP ${response.status}`);
    const data = await response.json();
    if (data.status !== 'success') {
        throw new Error(`Huawei rejected request (${String(data.error_code ?? 'unknown')})`);
    }
    return data.result;
}
const bytes = await readFile(path);
if (bytes.length > 100 * 1024 * 1024) throw new Error('CARTS exceeds single-upload limit of 100 MiB');
const form = new FormData();
form.set('file', new Blob([bytes]), basename(path));
for (const [key, value] of Object.entries({
    chunk_index: 1, merge: true, total_chunk_num: 1,
    parent_file_size: bytes.length, parent_file_name: basename(path), override: false,
    chunk_md5: createHash('md5').update(bytes).digest('hex'),
    parent_file_sha256: createHash('sha256').update(bytes).digest('hex'),
})) form.set(key, String(value));
const uploaded = await request('v2/fileservice/file/upload', { method: 'POST', body: form });
const task = typeof uploaded === 'string' ? uploaded : uploaded?.task_id;
if (typeof task !== 'string' || !task) throw new Error('Upload returned no task ID');
console.log('CARTS uploaded; waiting for marketplace checks.');
const route = `v1/marketplace/extension/${encodeURIComponent(task)}`;
let passed = false;
for (let attempt = 0; attempt < 60; attempt++) {
    const result = await request(`${route}/status`);
    const checks = ['basicInformation', 'file', 'security'].map(key => result?.[key]);
    if (checks.every(check => check?.status === 'success')) {
        passed = true;
        break;
    }
    if (checks.some(check => ['error', 'fail', 'failed'].includes(check?.status) || check?.errors?.length)) {
        throw new Error('Huawei marketplace checks rejected the package; inspect the publisher console.');
    }
    await setTimeout(3000);
}
if (!passed) throw new Error('Huawei marketplace checks timed out; package was not published.');
await request(`${route}/archiving`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 1 }),
});
console.log('Huawei marketplace accepted the formal publication request.');
