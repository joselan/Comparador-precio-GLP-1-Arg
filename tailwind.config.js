/** Config de Tailwind para el build del front (espeja la que estaba inline en el HTML). */
module.exports = {
  darkMode: 'class',
  content: ['./src/index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      // Tipografía +20%: misma escala nombrada que usaba la app.
      fontSize: {
        'xs':   ['0.9rem',   { lineHeight: '1.2rem' }],
        'sm':   ['1.05rem',  { lineHeight: '1.5rem' }],
        'base': ['1.2rem',   { lineHeight: '1.8rem' }],
        'lg':   ['1.35rem',  { lineHeight: '2.1rem' }],
        'xl':   ['1.5rem',   { lineHeight: '2.1rem' }],
        '2xl':  ['1.8rem',   { lineHeight: '2.4rem' }],
        '3xl':  ['2.25rem',  { lineHeight: '2.7rem' }],
        '4xl':  ['2.7rem',   { lineHeight: '3rem' }],
        '5xl':  ['3.6rem',   { lineHeight: '1' }],
      },
    },
  },
};
