// Shared button styles so dialogs and forms stay visually consistent. Matches
// the app's native Tailwind styling (see LoginPage's submit button).
const base = 'rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40';

export const btnPrimary = `${base} bg-neutral-900 text-white hover:bg-neutral-700`;
export const btnSecondary = `${base} border border-neutral-300 text-neutral-700 hover:bg-neutral-100`;
