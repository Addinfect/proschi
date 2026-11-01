import type { Page } from '@playwright/test';
import lz from 'lz-string';
import { DRONE_TEAM_FILES, droneOrgSource } from '../src/playground/droneStartup';
import { canvasNodes, codeEditor, editorText, expect, test } from './fixtures';
import { droneLink } from './drone';

/** A system box on the canvas, by its name. */
const box = (page: Page, name: string) => page.locator('.react-flow__node-systemNode', { hasText: name });
const status = (page: Page, name: string) => box(page, name).locator('.pc-system__pill');
const breadcrumb = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

/** Waits until the boxes have glided into their layout, so a pointer lands where it aims. */
async function layoutSettled(page: Page) {
  const positions = () => page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).style.transform).join('|'));
  let last = '';
  await expect
    .poll(async () => {
      const now = await positions();
      const same = now === last;
      last = now;
      return same;
    }, { intervals: [300] })
    .toBe(true);
}

test.describe('team systems in the editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(droneLink(100));
    await expect(codeEditor(page)).toBeVisible();
    await expect(box(page, 'Order Processing')).toBeVisible();
    await layoutSettled(page);
  });

  test('a collapsed box shows its team, promise, load and OK status', async ({ page }) => {
    const orders = box(page, 'Order Processing');
    await expect(orders).toContainText('@Orders');
    await expect(orders).toContainText('p99 < 150 ms · ≥ 99.9%');
    await expect(orders).toContainText(/100 \/ 1\.2k rps/);
    await expect(orders.getByRole('list', { name: 'Entry points' })).toHaveText('api');
    await expect(status(page, 'Order Processing')).toHaveText('OK');
    await expect(box(page, 'Payments')).toContainText('Declared, no design linked');
    await expect(page.locator('.pc-system[data-status="over"]')).toHaveCount(0);
  });

  test('more traffic through the frontend turns Orders red, with who to ask', async ({ page }) => {
    await codeEditor(page).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(droneOrgSource(2000));
    await expect.poll(() => editorText(page)).toContain('"Buy drone" 2000 rps');

    await expect(status(page, 'Order Processing')).toHaveText('Saturated');
    await expect(box(page, 'Order Processing').locator('.pc-system')).toHaveAttribute('data-status', 'over');
    await expect(box(page, 'Order Processing')).toContainText(/2k \/ 1\.2k rps/);
    // The other teams still hold.
    await expect(status(page, 'Frontend')).toHaveText('OK');

    // The findings and the hint, on hover or focus of the status.
    await layoutSettled(page);
    await status(page, 'Order Processing').focus();
    const tip = box(page, 'Order Processing').getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/Saturated · db at \d+%/);
    await expect(tip).toContainText('You send 2k rps');
    await expect(tip).toContainText(/Takes at most 1\.2k rps before db saturates/);
    await expect(tip).toContainText('ask the Orders team to add capacity for it (their bottleneck is db)');
    // Beside the box, so the Frontend box above stays clear.
    const tipBox = (await tip.boundingBox())!;
    const ordersBox = (await box(page, 'Order Processing').boundingBox())!;
    const frontendBox = (await box(page, 'Frontend').boundingBox())!;
    expect(tipBox.x).toBeGreaterThanOrEqual(ordersBox.x + ordersBox.width);
    expect(tipBox.y + tipBox.height <= frontendBox.y || tipBox.y >= frontendBox.y + frontendBox.height || tipBox.x >= frontendBox.x + frontendBox.width).toBe(true);
    // The entry point chip stays whole beside the buttons on a red box.
    const chip = (await box(page, 'Order Processing').getByRole('list', { name: 'Entry points' }).getByText('api').boundingBox())!;
    const open = (await box(page, 'Order Processing').getByRole('button', { name: 'Open Order Processing' }).boundingBox())!;
    expect(chip.height).toBeGreaterThan(10);
    expect(chip.x + chip.width).toBeLessThanOrEqual(open.x);
    expect(chip.y + chip.height).toBeLessThanOrEqual(ordersBox.y + ordersBox.height);

    // Results list the system too.
    await page.getByRole('tab', { name: /Results/ }).click();
    const systems = page.getByRole('region', { name: 'Systems' });
    await expect(systems.getByRole('row', { name: /Order Processing/ })).toContainText('Saturated');
    await expect(systems.getByRole('row', { name: /Payments/ })).toContainText('declared, no design linked');
  });

  test('double-click opens a team design, and the breadcrumb goes back', async ({ page }) => {
    const before = await editorText(page);
    page.on('dialog', (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.message()}`);
    });
    await box(page, 'Order Processing').dblclick();
    await expect(breadcrumb(page)).toContainText('Drone startup');
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText('Order Processing');
    await expect(page.locator('.react-flow__node', { hasText: 'Orders DB' })).toBeVisible();
    // The design is shown under its own traffic plus what the org sends.
    await expect(breadcrumb(page)).toContainText('incl. 100 rps from Drone startup');
    await expect(box(page, 'Frontend')).toHaveCount(0);
    // The code pane shows the team file, read-only: it came with the link.
    const teamBar = page.getByRole('group', { name: 'Team file' });
    await expect(teamBar).toContainText('teams/orders.proschi');
    await expect(teamBar).toContainText('Read-only');
    await expect(teamBar).toContainText('It came with the link this diagram was opened from.');
    await expect(codeEditor(page)).toHaveAttribute('contenteditable', 'false');
    expect(await editorText(page)).toBe(DRONE_TEAM_FILES['teams/orders.proschi']);
    // Its use cases are the team's own.
    await expect(page.getByRole('combobox').first()).toContainText('Place order');

    await breadcrumb(page).getByRole('button', { name: 'Drone startup', exact: true }).click();
    await expect(breadcrumb(page)).toBeHidden();
    await expect(box(page, 'Frontend')).toBeVisible();
    // Navigating is a view: the text is untouched.
    expect(await editorText(page)).toBe(before);

    // The Open button works from the keyboard too.
    await box(page, 'Warehouse').getByRole('button', { name: 'Open Warehouse' }).focus();
    await page.keyboard.press('Enter');
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText('Warehouse');
    await breadcrumb(page).getByRole('button', { name: 'Back to Drone startup' }).click();
    await expect(box(page, 'Warehouse')).toBeVisible();
  });

  test('the load overlay moves its dots along the drawn connections', async ({ page }) => {
    await page.getByRole('button', { name: 'Overlay: load' }).click();
    await layoutSettled(page);
    // Every drawn dot pixel of the particle canvas lies on a connection's line, even one routed around a corner.
    const offPath = () =>
      page.locator('.react-flow').evaluate((flow) => {
        const canvas = flow.querySelector<HTMLCanvasElement>('canvas[aria-hidden="true"]')!;
        const rect = canvas.getBoundingClientRect();
        const scale = canvas.width / rect.width;
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        const line: { x: number; y: number }[] = [];
        for (const path of Array.from(flow.querySelectorAll<SVGPathElement>('.react-flow__edge-path'))) {
          const ctm = path.getScreenCTM()!;
          for (let at = 0, length = path.getTotalLength(); at <= length; at += 2) {
            const p = path.getPointAtLength(at).matrixTransform(ctm);
            line.push({ x: p.x, y: p.y });
          }
        }
        let dots = 0;
        let off = 0;
        for (let y = 0; y < canvas.height; y += 2) {
          for (let x = 0; x < canvas.width; x += 2) {
            if (pixels[(y * canvas.width + x) * 4 + 3] < 200) continue;
            dots++;
            const sx = rect.x + x / scale;
            const sy = rect.y + y / scale;
            if (!line.some((p) => Math.hypot(p.x - sx, p.y - sy) <= 6)) off++;
          }
        }
        return { dots, off };
      });
    await expect.poll(async () => (await offPath()).dots).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      expect((await offPath()).off).toBe(0);
      await page.waitForTimeout(150);
    }
  });

  test('Format code keeps the references to entry points whole', async ({ page }) => {
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: /Format code/ }).click();
    // The connections line up, so the document did change.
    await expect.poll(() => editorText(page)).toContain('\nshopper  -> frontend.web    : HTTPS\n');
    const text = await editorText(page);
    expect(text).toContain('\nfrontend -> orders.api      : place order\n');
    expect(text).not.toMatch(/ \.(web|api|stock|charge|events)\b/);
    await expect(status(page, 'Order Processing')).toHaveText('OK');
  });

  test('a box expands in place and collapses again', async ({ page }) => {
    const before = await editorText(page);
    await box(page, 'Order Processing').getByRole('button', { name: 'Expand Order Processing', exact: true }).click();
    const frame = page.locator('.react-flow__node-groupNode', { hasText: 'Order Processing' });
    await expect(frame).toBeVisible();
    await expect(page.locator('.react-flow__node', { hasText: 'Orders DB' })).toBeVisible();
    await expect(frame.locator('.pc-system__pill')).toHaveText('OK');
    // The header's controls keep clear of the frame's border.
    const frameBox = (await frame.locator('.pc-group').boundingBox())!;
    const collapse = (await frame.getByRole('button', { name: 'Collapse Order Processing' }).boundingBox())!;
    expect(collapse.x + collapse.width).toBeLessThanOrEqual(frameBox.x + frameBox.width - 8);
    expect(collapse.y).toBeGreaterThanOrEqual(frameBox.y + 8);
    // With the load overlay on, its members show their load like any node.
    await page.getByRole('button', { name: 'Overlay: load' }).click();
    await expect(page.locator('.react-flow__node', { hasText: 'Orders DB' }).locator('.pc-node[data-load]')).toBeVisible();
    await expect(page.locator('.react-flow__node', { hasText: 'Orders DB' })).toContainText(/\d+%/);
    await page.getByRole('button', { name: 'Overlay: load' }).click();
    // A long use case name does not widen the picker; its full name is in the title.
    const picker = page.getByRole('combobox', { name: 'Use case' });
    expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(11 * 16 + 1);
    await expect(picker).toHaveAttribute('title', /\S/);
    // The rest of the org stays collapsed.
    await expect(box(page, 'Frontend')).toBeVisible();
    await expect(box(page, 'Order Processing')).toHaveCount(0);

    await frame.getByRole('button', { name: 'Collapse Order Processing' }).click();
    await expect(box(page, 'Order Processing')).toBeVisible();
    await expect(page.locator('.react-flow__node', { hasText: 'Orders DB' })).toHaveCount(0);
    expect(await editorText(page)).toBe(before);
  });
});

test.describe('team systems on a busy org', () => {
  test('the warning tooltip stays on the canvas when the box sits at its right edge', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(droneLink(2000));
    await expect(status(page, 'Order Processing')).toHaveText('Saturated');
    await layoutSettled(page);
    // Drag the canvas until the box touches its right edge.
    const canvas = (await page.locator('.react-flow').boundingBox())!;
    const orders = (await box(page, 'Order Processing').boundingBox())!;
    await page.mouse.move(canvas.x + 5, canvas.y + 60);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 5 + (canvas.x + canvas.width - (orders.x + orders.width) - 10), canvas.y + 60, { steps: 8 });
    await page.mouse.up();

    await status(page, 'Order Processing').focus();
    const tip = box(page, 'Order Processing').getByRole('tooltip');
    await expect(tip).toBeVisible();
    const tipBox = (await tip.boundingBox())!;
    expect(tipBox.x).toBeGreaterThanOrEqual(canvas.x);
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(canvas.x + canvas.width);
  });

  test('a saturated node keeps readable text on its red fill, in the dark theme too', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(droneLink(2000));
    await expect(status(page, 'Order Processing')).toHaveText('Saturated');
    await layoutSettled(page);
    await box(page, 'Order Processing').dblclick();
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText('Order Processing');
    await page.getByRole('button', { name: 'Overlay: load' }).click();
    const db = page.locator('.react-flow__node', { hasText: 'Orders DB' }).locator('.pc-node');
    await expect(db).toHaveAttribute('data-heat', 'accent');
    // The dark text drawn on accents, not the theme's light ink or its muted grey.
    await expect(db.locator('.pc-node__name')).toHaveCSS('color', 'rgb(17, 17, 17)');
    await expect(db.locator('.pc-node__tech')).toHaveCSS('color', 'rgb(17, 17, 17)');
  });
});

test('a narrow team design with a long name keeps its frame controls inside the border', async ({ page }) => {
  const org = droneOrgSource(100).replace('"Feed" @Feed', '"Customer Feed Notifications" @FeedAndNotifications');
  const feed = 'title "Feed"\ncaller "Callers" [Actor]\ningest "Ingest" [Microservice]\ncaller -> ingest\nusecase "Publish event" {\n  caller -> ingest : POST\n}\n';
  const files = { ...DRONE_TEAM_FILES, 'teams/feed.proschi': feed };
  await page.goto(`app/#code=${lz.compressToEncodedURIComponent(org)}&imports=${lz.compressToEncodedURIComponent(JSON.stringify(files))}`);
  await box(page, 'Customer Feed Notifications').getByRole('button', { name: 'Expand Customer Feed Notifications', exact: true }).click();
  const frame = page.locator('.react-flow__node-groupNode', { hasText: 'Customer Feed Notifications' }).locator('.pc-group');
  await expect(frame).toBeVisible();
  await layoutSettled(page);
  const frameBox = (await frame.boundingBox())!;
  for (const name of ['Open', 'Collapse']) {
    const button = (await frame.getByRole('button', { name: `${name} Customer Feed Notifications` }).boundingBox())!;
    expect(button.x).toBeGreaterThanOrEqual(frameBox.x + 8);
    expect(button.x + button.width).toBeLessThanOrEqual(frameBox.x + frameBox.width - 8);
  }
});

test('the drone example opens its team files as diagrams, which Open edits', async ({ page }) => {
  await page.goto('app/');
  const openDrone = async () => {
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Examples…' }).click();
    await page.getByRole('dialog', { name: 'Examples' }).getByRole('button', { name: 'Drone startup (team systems)' }).click();
    await expect(box(page, 'Order Processing')).toBeVisible();
  };
  await openDrone();
  await expect(status(page, 'Order Processing')).toHaveText('OK');
  await layoutSettled(page);

  // An org edit not yet saved, then into the Orders team.
  await codeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# org note\n');
  await box(page, 'Order Processing').getByRole('button', { name: 'Open Order Processing' }).click();
  await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText('Order Processing');
  const teamBar = page.getByRole('group', { name: 'Team file' });
  await expect(teamBar).toContainText('teams/orders.proschi');
  await expect(teamBar).toContainText('Saved in this browser');
  expect(await editorText(page)).toBe(DRONE_TEAM_FILES['teams/orders.proschi']);

  // Edit the team file: its database now takes 50 rps.
  await codeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(DRONE_TEAM_FILES['teams/orders.proschi'].replace('db 1.5k rps', 'db 50 rps'));

  // Back at the org, the box says so, and the org's text and its undo history are as they were.
  await teamBar.getByRole('button', { name: 'Drone startup' }).click();
  await expect(teamBar).toBeHidden();
  await expect(status(page, 'Order Processing')).toHaveText('Saturated');
  expect(await editorText(page)).toContain('# org note');
  await codeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => editorText(page)).not.toContain('# org note');

  // Opening the example again adds an org diagram but no second copy of a team file; it reads the edited one.
  await openDrone();
  await expect(status(page, 'Order Processing')).toHaveText('Saturated');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('proschi.docs') ?? '{"docs":[]}') as { docs: { fileName?: string }[] };
        return state.docs.map((d) => d.fileName).filter((f) => f?.startsWith('teams/')).length;
      }),
    )
    .toBe(4);
});

test('a component added from the palette next to team systems leaves every box shown', async ({ page }) => {
  await page.goto(droneLink(100));
  await expect(box(page, 'Order Processing')).toBeVisible();
  const before = await canvasNodes(page).count();
  await page.getByRole('button', { name: 'Add component' }).click();
  const palette = page.getByRole('dialog', { name: 'Add a component' });
  await palette.getByRole('searchbox', { name: 'Search components' }).fill('redis');
  await palette.getByRole('button', { name: 'Redis', exact: true }).click();
  await expect(palette).toBeHidden();
  // A new layout keeps the sizes React Flow measured; a node without one stays hidden until measured again.
  await expect(canvasNodes(page)).toHaveCount(before + 1);
});
