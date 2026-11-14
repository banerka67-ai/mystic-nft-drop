# Mystic NFT Drop

Первая версия Telegram Mini App: виртуальный баланс и серверная рулетка с виртуальными подарками.

## Запуск локально
1. Установите Python 3.11+.
2. Выполните `pip install -r requirements.txt`.
3. Скопируйте `.env.example` в `.env` и заполните `BOT_TOKEN` (для Telegram) и `ADMIN_IDS`.
4. Запустите: `uvicorn backend.main:app --reload`.
5. Откройте http://127.0.0.1:8000.

Для локального просмотра без Telegram можно установить `DEV_MODE=true`. В production этот режим отключайте.

## Render
Создайте Web Service из репозитория. Build command: `pip install -r requirements.txt`. Start command: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`. Добавьте переменные окружения из `.env.example`. Для постоянного хранения SQLite подключите Render Persistent Disk и задайте `DB_PATH=/var/data/mystic.sqlite3`.

Все монеты и подарки в этой версии виртуальные, без денежной стоимости и вывода средств.
