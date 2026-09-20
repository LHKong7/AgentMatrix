// The application's select is a shadcn/Radix listbox, not a native <select>, so acceptance
// tests open the trigger and click an option instead of calling Playwright's selectOption.
// Options carry the value they store in `data-value`, matching what selectOption accepted.

export async function chooseOption(page, trigger, option) {
  await trigger.click()
  const target =
    typeof option === 'string'
      ? page.getByRole('option').and(page.locator(`[data-value="${option}"]`))
      : page.getByRole('option', { name: option.label, exact: true })
  await target.first().click()
  await page.getByRole('listbox').waitFor({ state: 'hidden' })
}

export function languageSelect(page) {
  return page.locator('.language-select').first().getByRole('combobox')
}
