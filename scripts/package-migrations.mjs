import { cp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = 'drizzle';
const destination = join('dist', 'dead_puck_situation_room', 'drizzle');
const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8'));
if (!journal.entries?.length) throw new Error('No generated D1 migration journal was found.');
await cp(source, destination, { recursive: true, force: true });
const packaged = await readdir(destination);
if (!packaged.some((name) => name.endsWith('.sql')) || !packaged.includes('meta')) {
  throw new Error('The Sites build did not package the D1 migration.');
}
