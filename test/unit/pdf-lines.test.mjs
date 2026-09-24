import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageText, unspace } from '../../src/options/pdf-lines.js';

test('letter-spaced capitals become words again', () => {
  assert.equal(unspace('M O S A M'), 'MOSAM');
  assert.equal(unspace('B . T E C H'), 'B.TECH');
  assert.equal(unspace('J A N  2 0 2 6'), 'JAN 2026');
  assert.equal(unspace('Final-year B.Tech student'), 'Final-year B.Tech student');
  assert.equal(unspace('I am'), 'I am');
});

test('items on one line join, new lines start where the baseline moves', () => {
  const at = (str, x, y, width, extra = {}) => ({ str, transform: [1, 0, 0, 1, x, y], width, ...extra });
  const text = pageText([
    at('M O S A M', 40, 800, 23),
    at(' ', 63, 800, 8),
    at('B I S W A S', 69, 800, 28, { hasEOL: true }),
    at('Software', 40, 780, 30),
    at('developer', 75, 780, 35),
  ]);
  assert.equal(text, 'MOSAM BISWAS\nSoftware developer');
});

test('columns on one line are kept apart', () => {
  const at = (str, x, y, width, height = 6.4) => ({ str, transform: [1, 0, 0, 1, x, y], width, height });
  // A big name beside the email, and a job title with its dates far right,
  // once as a plain gap and once spanned by a wide blank item.
  const text = pageText([
    at('MOSAM', 40, 709, 343, 52),
    at('M O S A M B I S W A S 9 9 9 @ G M A I L . C O M', 440, 709.2, 115),
    at('Intern at Sedna', 40, 690, 60),
    at(' ', 100, 690, 148, 0),
    at('J A N', 248, 690, 14),
    at(' ', 262, 690, 7.6, 0),
    at('2 0 2 6', 268, 690, 18),
  ]);
  assert.equal(text, 'MOSAM | MOSAMBISWAS999@GMAIL.COM\nIntern at Sedna | JAN 2026');
});
