import { COMPOSER_INPUT, test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function openGitChanges(page: Page) {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create review session');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create review session/)).toBeVisible();
  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
  await page.getByRole('button', { name: /变更.*查看当前 Git 工作区变化/ }).click();
  return page.getByRole('region', { name: 'Git 变更' });
}

test('titlebar workbar action restores an existing tool instead of the picker', async ({
  gitReviewWindow,
}) => {
  const page = gitReviewWindow.page;
  const workspaceActions = page.getByRole('toolbar', { name: '工作区辅助操作' });
  const panel = await openGitChanges(page);
  const panelToolbar = page.getByRole('toolbar', { name: '任务工作栏标签' }).first();
  const collapseButton = panelToolbar.getByRole('button', { name: '收起任务工作栏' });
  await expect(workspaceActions).toHaveCount(0);
  await expect(collapseButton).toBeVisible();
  await expect(workspaceActions.getByRole('button', { name: '打开工作栏工具' })).toHaveCount(0);

  const activeTab = panelToolbar.getByRole('tab', { selected: true });
  await expect(activeTab).toBeVisible();
  const [toolbarBox, tabBox, toggleBox] = await Promise.all([
    panelToolbar.boundingBox(),
    activeTab.boundingBox(),
    collapseButton.boundingBox(),
  ]);
  expect(toolbarBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(
    Math.abs(tabBox!.y + tabBox!.height / 2 - (toggleBox!.y + toggleBox!.height / 2)),
  ).toBeLessThanOrEqual(1);

  const simulatedCaptionWidth = 80;
  await page.evaluate((width) => {
    document.documentElement.style.setProperty(
      '--maka-titlebar-overlay-right-width',
      `${width}px`,
    );
  }, simulatedCaptionWidth);
  await expect
    .poll(async () => (await collapseButton.boundingBox())?.x)
    .toBe(toggleBox!.x - simulatedCaptionWidth);
  const safeAreaToggleBox = await collapseButton.boundingBox();
  expect(safeAreaToggleBox).not.toBeNull();

  await page.getByRole('button', { name: '打开工作栏标签' }).click();
  const picker = page.getByRole('list', { name: '打开工具' });
  await expect(picker).toBeVisible();

  await collapseButton.click();
  const expandButton = workspaceActions.getByRole('button', { name: '展开任务工作栏' });
  await expect(expandButton).toBeVisible();
  const expandButtonBox = await expandButton.boundingBox();
  expect(expandButtonBox).not.toBeNull();
  expect(Math.abs(expandButtonBox!.y - safeAreaToggleBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(expandButtonBox!.x - safeAreaToggleBox!.x)).toBeLessThanOrEqual(1);
  await expandButton.click();

  await expect(panel).toBeVisible();
  await expect(picker).not.toBeVisible();
  const restoredCollapseButton = panelToolbar.getByRole('button', {
    name: '收起任务工作栏',
  });
  await expect(restoredCollapseButton).toBeVisible();
  const restoredToggleBox = await restoredCollapseButton.boundingBox();
  expect(restoredToggleBox).not.toBeNull();
  expect(Math.abs(restoredToggleBox!.y - safeAreaToggleBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(restoredToggleBox!.x - safeAreaToggleBox!.x)).toBeLessThanOrEqual(1);
});

test('Git changes re-read the workspace after the app regains focus', async ({
  gitReviewWindow,
}) => {
  const panel = await openGitChanges(gitReviewWindow.page);
  await expect(panel.getByText('新增 4 行')).toBeVisible();

  await writeFile(join(gitReviewWindow.projectRoot, 'base.txt'), 'base\nunstaged\nexternal\n');
  await gitReviewWindow.page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(panel.getByText('新增 5 行')).toBeVisible();
});
