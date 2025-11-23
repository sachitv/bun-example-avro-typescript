import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('/');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Avro TypeScript Browser Example/);
});

test('run avro example', async ({ page }) => {
  await page.goto('/');

  // Click the run button.
  await page.getByRole('button', { name: 'Run Avro Example' }).click();

  // Expect the output to contain the correct text.
  const output = page.locator('#output');
  await expect(output).toContainText('Avro data written to and read from in-memory buffer:');
  await expect(output).toContainText('"id": "1n"');
  await expect(output).toContainText('"username": "user1"');
  await expect(output).toContainText('"email": "user1@example.com"');
  await expect(output).toContainText('"age": 25');
  await expect(output).toContainText('"id": "2n"');
  await expect(output).toContainText('"username": "user2"');
  await expect(output).toContainText('"email": "user2@example.com"');
  await expect(output).toContainText('"age": 30');
});
