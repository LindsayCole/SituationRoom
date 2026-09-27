import { cp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = 'drizzle';
const destination = join('dist', 'dead_puck_situation_room', 'drizzle');
const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8'));
if (journal.entries?.map((entry) => entry.tag).join(',') !==
  '0000_situation_room_persistence,0001_yahoo_auth_and_history') {
  throw new Error('The D1 migration journal does not contain the baseline and upgrade.');
}
await cp(source, destination, { recursive: true, force: true });
const packaged = await readdir(destination);
if (!packaged.includes('0000_situation_room_persistence.sql') ||
    !packaged.includes('0001_yahoo_auth_and_history.sql') || !packaged.includes('meta')) {
  throw new Error('The Sites build did not package the D1 migration.');
}
