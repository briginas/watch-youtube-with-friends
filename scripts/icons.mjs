// Выбранные AI-исходники сохранены в репозитории; повторная генерация не нужна.
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

await mkdir('public/icon', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  // Прозрачные поля оставляют знак различимым на панели Chrome и в Store.
  const artwork = Math.round(size * 0.8);
  const inset = Math.floor((size - artwork) / 2);
  await sharp('assets/icon-plush.png')
    .resize(artwork, artwork, { fit: 'contain', kernel: 'lanczos3' })
    .extend({
      top: inset, left: inset,
      bottom: size - artwork - inset, right: size - artwork - inset,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(`public/icon/${size}.png`);
}

await sharp('docs/store-assets/promo-plush-source.png')
  .resize(440, 280, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
  .flatten({ background: '#f4c2a0' })
  .removeAlpha()
  .png()
  .toFile('docs/store-assets/promo-plush-440x280.png');

await mkdir('public/assets', { recursive: true });
await sharp('docs/store-assets/promo-plush-source.png')
  .resize(800, 236, { fit: 'cover', position: 'centre' })
  .webp({ quality: 85 })
  .toFile('public/assets/popup-plush.webp');

console.log('PNG-иконки 16/32/48/128, small promo tile 440×280 и баннер popup готовы.');
