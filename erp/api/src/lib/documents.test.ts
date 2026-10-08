import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCPF, isValidCNPJ } from './documents.js';
import { hashPassword, verifyPassword, passwordIssue } from './security.js';

test('CPF/CNPJ', () => {
  assert.ok(isValidCPF('529.982.247-25'));
  assert.ok(!isValidCPF('529.982.247-24'));
  assert.ok(!isValidCPF('111.111.111-11'));
  assert.ok(isValidCNPJ('11.222.333/0001-81'));
  assert.ok(!isValidCNPJ('11.222.333/0001-80'));
});
test('senha', async () => {
  const h = await hashPassword('Senha12345');
  assert.ok(!h.includes('Senha12345'));
  assert.ok(await verifyPassword('Senha12345', h));
  assert.ok(!(await verifyPassword('outra', h)));
  assert.ok(passwordIssue('curta1'));
  assert.equal(passwordIssue('Senha12345'), null);
});
