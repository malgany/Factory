import { describe, expect, it } from 'vitest';

import { isLocalAdminHost } from './localAdmin';

describe('isLocalAdminHost', () => {
  it.each(['localhost', 'LOCALHOST', 'editor.localhost', '127.0.0.1', '::1', '[::1]'])(
    'permite o modo admin em %s',
    (hostname) => expect(isLocalAdminHost(hostname)).toBe(true),
  );

  it.each(['', 'factory.test', 'localhost.example.com', '127.0.0.2', '0.0.0.0'])(
    'bloqueia o modo admin em %s',
    (hostname) => expect(isLocalAdminHost(hostname)).toBe(false),
  );
});
