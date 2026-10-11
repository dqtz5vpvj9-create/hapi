import {test} from '@e2e-dev/web';
import {expect} from 'e2e';
test('command summary stays one line and output requires opening details',async({app,browser,screen})=>{
 await app.open('/e2e-fixtures/codex-command-fixture.html');
 const label=screen.getByText(/^Ran ls -ld/); await expect(label).toBeVisible();
 const g=await browser.evaluate(()=>{const e=Array.from(document.querySelectorAll('*')).find(n=>n.childElementCount===0 && n.textContent?.startsWith('Ran ls -ld'))!;const s=getComputedStyle(e);return {height:e.getBoundingClientRect().height,line:parseFloat(s.lineHeight),whiteSpace:s.whiteSpace,overflow:s.textOverflow};});
 expect(g.height).toBeLessThanOrEqual(g.line+1);expect(g.whiteSpace).toBe('nowrap');expect(g.overflow).toBe('ellipsis');
 await expect(screen.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0);
 expect(await browser.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await screen.getByRole('button',/Ran ls -ld/).tap();await expect(screen.getByRole('dialog')).toContainText('DETAIL_OUTPUT_ONLY');
 await app.screenshot('command-details');await screen.getByRole('button','Close').tap();await expect(screen.getByRole('dialog')).toHaveCount(0);await expect(label).toBeVisible();await expect(screen.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0);
});
