import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import mongoose from 'mongoose';
import StoredFileModel from '../models/StoredFile.js';
import { putObject, getObject, deleteObject } from '../lib/storage.js';

test('MongoDB large uploads round-trip through GridFS and clean up on replacement or deletion', async t => {
  const records = new Map();
  const files = new Map();
  class FakeBucket {
    find({ _id }) { return { hasNext: async () => files.has(_id) }; }
    async delete(id) { files.delete(id); }
    openUploadStreamWithId(id) {
      const chunks = [];
      return new Writable({
        write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
        final(callback) { files.set(id, Buffer.concat(chunks)); callback(); },
      });
    }
    openDownloadStream(id) { return Readable.from([files.get(id)]); }
  }
  t.mock.getter(mongoose.mongo, 'GridFSBucket', () => FakeBucket);
  t.mock.getter(mongoose, 'connection', () => ({ readyState: 1, db: {} }));
  t.mock.method(StoredFileModel, 'updateOne', async ({ _id }, { $set }) => { records.set(_id, $set); });
  t.mock.method(StoredFileModel, 'deleteOne', async ({ _id }) => { records.delete(_id); });
  t.mock.method(StoredFileModel, 'findById', id => ({ lean: async () => records.get(id) || null }));

  const path = 'uploads/g_test/large.pdf';
  const small = Buffer.from('%PDF-small');
  const large = Buffer.alloc(50 * 1024 * 1024, 32);
  large.write('%PDF-large');
  const ref = await putObject(path, small, 'application/pdf');
  assert.equal(ref.driver, 'mongo');
  assert.deepEqual(await getObject(ref), small);
  await putObject(path, large, 'application/pdf');
  assert.equal(records.size, 0, 'large bytes never enter a BSON document');
  assert.equal(files.size, 1);
  assert.deepEqual(await getObject(ref), large);
  await putObject(path, large, 'application/pdf');
  assert.equal(files.size, 1, 'retries replace the same original');
  await putObject(path, small, 'application/pdf');
  assert.equal(files.size, 0, 'small replacement removes old GridFS chunks');
  assert.deepEqual(await getObject(ref), small);
  await putObject(path, large, 'application/pdf');
  await deleteObject(ref);
  assert.equal(files.size, 0);
  assert.equal(await getObject(ref), null);
});
