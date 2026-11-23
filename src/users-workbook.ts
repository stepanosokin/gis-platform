import type { SheetData } from 'write-excel-file/node';
import { writeReport } from './operator-inventory.js';

export interface ReportUser {
  email: string;
  name: string;
  registeredAt: string;
  status: string;
  publications: { id: string; title: string; access: string; anonymous: boolean }[];
}

function excelText(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udfff]/gu, '\ufffd');
}

export async function writeUsersWorkbook(file: string, users: ReportUser[]) {
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const accounts: SheetData = [['Имя', 'Email', 'Дата регистрации (UTC)', 'Статус', 'Число публикаций']];
  const access: SheetData = [['Email', 'ID публикации', 'Название', 'Режим', 'Анонимный доступ']];
  for (const user of users) {
    const email = excelText(user.email);
    accounts.push([excelText(user.name), email,
      { value: new Date(user.registeredAt), type: Date, format: 'yyyy-mm-dd hh:mm:ss' }, user.status, user.publications.length]);
    for (const publication of user.publications) {
      access.push([email, publication.id, excelText(publication.title), publication.access, publication.anonymous]);
    }
  }
  const bytes = await writeXlsxFile([accounts, access], {
    buffer: true, sheets: ['Пользователи', 'Доступные публикации'],
    columns: [[{ width: 26 }, { width: 34 }, { width: 24 }, { width: 16 }, { width: 19 }],
      [{ width: 34 }, { width: 24 }, { width: 35 }, { width: 16 }, { width: 20 }]],
  });
  await writeReport(file, bytes);
  return { file, count: users.length };
}
