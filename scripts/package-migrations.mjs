import { cp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = 'drizzle';
const destination = join('dist', 'dead_puck_situation_room', 'drizzle');
const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8'));
const tags = ['0000_situation_room_persistence', '0001_change_revision_uniqueness',
  '0002_revision_snapshots', '0003_yahoo_auth_and_history'];
if (journal.entries?.map((entry) => entry.tag).join(',') !== tags.join(',')) {
  throw new Error('The D1 migration journal does not contain the full upgrade path.');
}
await cp(source, destination, { recursive: true, force: true });
const packaged = await readdir(destination);
if (!tags.every((tag) => packaged.includes(`${tag}.sql`)) || !packaged.includes('meta')) {
  throw new Error('The Sites build did not package the D1 migration.');
}
