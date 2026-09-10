/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        dusk: {
          900: '#0C1122',
          800: '#10172A',
          700: '#1A2340',
          600: '#26304F',
        },
        lamp: {
          400: '#F5B34C',
          300: '#F8C77A',
          glow: '#FFE9C2',
        },
        cream: '#F4EFE4',
      },
    },
  },
  plugins: [],
};
