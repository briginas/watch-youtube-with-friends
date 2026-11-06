import { expect, it } from 'vitest';
import { generationRules } from '../../scripts/generation-rules.mjs';
it('генерирует точное поколение без probes, отклоняет недопустимые идентификаторы', () => {
  const rules = generationRules('g-fixture');
  expect(rules.rules.rooms.$key.metadata.backendGeneration['.validate']).toBe("newData.val() === 'g-fixture'");
  expect(rules.rules).not.toHaveProperty('_probes');
  expect(() => generationRules("x' || true")).toThrow();
});
