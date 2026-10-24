/* Orbita · миграция базы Cloudflare D1 под v0.3.0.

   Нужна только если база уже создана по прежнему schema.sql. Свежая база этого файла не
   видит: в schema.sql нужные таблицы и колонки уже есть.

   Как выполнить: dash.cloudflare.com → Storage & databases → D1 → база orbita → вкладка
   «Console» → вставить весь файл → Execute.

   Файл не задумывался как повторимый: у SQLite нет «add column if not exists». Если
   выполнить его дважды, D1 ответит «Duplicate column name secret_hash» — это значит, что
   миграция уже применена, и ничего ломать не нужно. */

/* Ключ удаления: в базе лежит только sha256 от него, поэтому даже полный дамп D1 не даёт
   возможность удалять чужие сообщения. */
alter table orb_msg add column secret_hash text;

/* id сообщения, на которое отвечает автор: без этой связи раздел «Ответы» не собрать,
   кнопка ↩ сохраняла только текст цитаты. */
alter table orb_msg add column reply_to text not null default '';

/* Присутствие больше не хранит адреса страниц: по старой таблице можно было восстановить,
   кто и где сидел. Данные живучие — строка перегорает через 5 минут, — поэтому таблицу
   просто пересоздаём, потерянные секунды «онлайна» восстановятся сами на первом же бите. */
drop table if exists orb_pres;

create table orb_pres (
  client text primary key,
  room   text not null,
  ts     integer not null
);

create index if not exists orb_pres_room on orb_pres (room, ts);
create index if not exists orb_pres_ts   on orb_pres (ts);

/* Ряды rate теперь живут сутки (раньше — час): суточный лимит на адрес нельзя считать по
   данным, которые подтирают каждый час. */
delete from orb_rate where ts < strftime('%s', 'now') * 1000 - 3600000;
