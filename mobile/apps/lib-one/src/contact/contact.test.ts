import { contactChannels } from './contact';

it('只列出有設定的管道，並組出可開啟的網址', () => {
  const list = contactChannels({ phone: '(02) 1234-5678', email: 'sales@example.com', website: 'example.com' }, 'LIB ONE 產品諮詢');
  expect(list.map((c) => c.url)).toEqual(['tel:0212345678', `mailto:sales@example.com?subject=${encodeURIComponent('LIB ONE 產品諮詢')}`, 'https://example.com']);
  expect(contactChannels({ phone: ' ', email: undefined })).toEqual([]);
});
