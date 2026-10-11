import {test} from '@e2e-dev/web';
import {expect} from 'e2e';
test('scratchlist entries persist, stay isolated by session, and can be copied',async({app,browser,screen})=>{
 await app.open('/e2e-fixtures/scratchlist-fixture.html?session=e2e-a');
 await expect(screen.getByTestId('scratchlist-panel')).toBeVisible();
 const toggle=screen.getByRole('button',/^Scratchlist/);await toggle.tap();
 await expect(toggle).toHaveAttribute('aria-expanded','true');
 await screen.getByLabel('Add scratchlist entry').fill('E2E persistent note');await screen.getByRole('button','Add').tap();await expect(screen.getByTestId('scratchlist-entry')).toHaveCount(1);
 await browser.reload();await expect(screen.getByTestId('scratchlist-panel')).toBeVisible();
 if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.tap();
 await expect(screen.getByText('E2E persistent note')).toBeVisible();
 await screen.getByRole('button','Copy into composer').tap();expect(await browser.evaluate(()=>(window as any).__scratchlistE2E.promotedToComposer)).toEqual(['E2E persistent note']);await expect(screen.getByTestId('scratchlist-entry')).toHaveCount(1);
 await app.open('/e2e-fixtures/scratchlist-fixture.html?session=e2e-b');await expect(screen.getByTestId('scratchlist-panel')).toBeVisible();await expect(screen.getByTestId('scratchlist-entry')).toHaveCount(0);
 await app.open('/e2e-fixtures/scratchlist-fixture.html?session=e2e-a');await expect(screen.getByTestId('scratchlist-entry')).toHaveCount(1);
 await app.screenshot('scratchlist-restored');
});
