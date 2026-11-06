import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publishRobloxCreatorStoreProduct } from '../src/services/roblox-assets.service.js';

const originalFetch = globalThis.fetch;
const requests = [];

const mockProductResponse = (product, status = 200) => new Response(
  JSON.stringify(product),
  { status, headers: { 'Content-Type': 'application/json' } }
);

afterEach(() => {
  globalThis.fetch = originalFetch;
  requests.length = 0;
});

test('Model is reported public only when Roblox confirms published and purchasable', async () => {
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return mockProductResponse({
      path: 'creator-store-products/101',
      modelAssetId: '9001',
      published: true,
      purchasable: true,
      restrictions: []
    });
  };

  const result = await publishRobloxCreatorStoreProduct({
    apiKey: 'test-secret',
    assetId: '9001',
    assetType: 'Model',
    creatorType: 'user',
    creatorId: '123'
  });

  assert.equal(result.public, true);
  assert.equal(result.status, 'public');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://apis.roblox.com/cloud/v2/creator-store-products');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['x-api-key'], 'test-secret');

  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.modelAssetId, '9001');
  assert.equal(payload.published, true);
  assert.deepEqual(payload.basePrice, {
    currencyCode: 'USD',
    quantity: { significand: 0, exponent: 0 }
  });
});

test('Audio uses the audioAssetId Creator Store product field', async () => {
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return mockProductResponse({
      path: 'creator-store-products/102',
      audioAssetId: '9002',
      published: true,
      purchasable: true,
      restrictions: []
    });
  };

  const result = await publishRobloxCreatorStoreProduct({
    apiKey: 'test-secret',
    assetId: '9002',
    assetType: 'Audio',
    creatorType: 'user',
    creatorId: '123'
  });

  assert.equal(result.public, true);
  assert.equal(JSON.parse(requests[0].body).audioAssetId, '9002');
});

test('Decal uses the decalAssetId Creator Store product field', async () => {
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return mockProductResponse({
      path: 'creator-store-products/103',
      decalAssetId: '9003',
      published: true,
      purchasable: true,
      restrictions: []
    });
  };

  const result = await publishRobloxCreatorStoreProduct({
    apiKey: 'test-secret',
    assetId: '9003',
    assetType: 'Decal',
    creatorType: 'group',
    creatorId: '456'
  });

  assert.equal(result.public, true);
  assert.equal(JSON.parse(requests[0].body).decalAssetId, '9003');
});

test('published product is not reported public if Roblox says it is not purchasable', async () => {
  globalThis.fetch = async () => mockProductResponse({
    path: 'creator-store-products/104',
    modelAssetId: '9004',
    published: true,
    purchasable: false,
    restrictions: []
  });

  const result = await publishRobloxCreatorStoreProduct({
    apiKey: 'test-secret',
    assetId: '9004',
    assetType: 'Model',
    creatorType: 'user',
    creatorId: '123'
  });

  assert.equal(result.published, true);
  assert.equal(result.purchasable, false);
  assert.equal(result.public, false);
  assert.equal(result.status, 'submitted_or_restricted');
});

test('restricted product is not reported public even if published and purchasable are true', async () => {
  globalThis.fetch = async () => mockProductResponse({
    path: 'creator-store-products/105',
    decalAssetId: '9005',
    published: true,
    purchasable: true,
    restrictions: ['SOLD_ITEM_RESTRICTED']
  });

  const result = await publishRobloxCreatorStoreProduct({
    apiKey: 'test-secret',
    assetId: '9005',
    assetType: 'Decal',
    creatorType: 'user',
    creatorId: '123'
  });

  assert.equal(result.public, false);
  assert.equal(result.status, 'submitted_or_restricted');
  assert.deepEqual(result.restrictions, ['SOLD_ITEM_RESTRICTED']);
});

test('Image does not call Creator Store API and reports Asset Privacy dependency', async () => {
  globalThis.fetch = async () => {
    assert.fail('Image must not call Creator Store product API');
  };

  const result = await publishRobloxCreatorStoreProduct({
    apiKey: 'test-secret',
    assetId: '9006',
    assetType: 'Image',
    creatorType: 'user',
    creatorId: '123'
  });

  assert.equal(result.attempted, false);
  assert.equal(result.public, false);
  assert.equal(result.status, 'privacy_setting_dependent');
});

test('unsupported type is not sent to Creator Store API', async () => {
  globalThis.fetch = async () => {
    assert.fail('Unsupported type must not call Creator Store API');
  };

  const result = await publishRobloxCreatorStoreProduct({
    apiKey: 'test-secret',
    assetId: '9007',
    assetType: 'Animation',
    creatorType: 'user',
    creatorId: '123'
  });

  assert.equal(result.attempted, false);
  assert.equal(result.public, false);
  assert.equal(result.status, 'unsupported_asset_type');
});
