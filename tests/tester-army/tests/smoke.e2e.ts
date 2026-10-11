import {test} from '@e2e-dev/web';
import {expect} from 'e2e';
test('workspace loads',async({app,browser})=>{await app.open('/e2e-fixtures/workspace-fixture.html?split');await expect(browser.locator('[data-workspace-ready=true]')).toBeVisible();await app.screenshot('tmux-ready');});
