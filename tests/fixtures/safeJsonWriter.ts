import { JsonChannelPostStore } from '../../src/channelPosts.js';

const [filePath, prefix, countValue] = process.argv.slice(2);
const count = Number(countValue);
if (!filePath || !prefix || !Number.isInteger(count) || count < 1) throw new Error('Invalid safe JSON writer fixture arguments.');

async function main(): Promise<void> {
  const store = new JsonChannelPostStore(filePath);
  for (let index = 0; index < count; index += 1) {
    await store.create(`${prefix} concurrent post ${index}`, undefined, index);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
