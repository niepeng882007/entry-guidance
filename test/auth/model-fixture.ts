import assert from 'node:assert/strict';

export const modelTransport: typeof fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.deepseek.com/models');
  assert.equal(init?.method ?? 'GET', 'GET');
  assert.equal(init?.redirect, 'error');
  const key = new Headers(init?.headers).get('Authorization');
  if (
    ![
      'Bearer synthetic-model-alice',
      'Bearer synthetic-model-alice-rotated',
      'Bearer synthetic-model-bob',
    ].includes(key ?? '')
  )
    return new Response('synthetic-private-upstream-error', { status: 401 });
  return Response.json({
    data: [{ id: 'deepseek-v4-pro', context_window: 100000, max_output_tokens: 16000 }],
  });
};
