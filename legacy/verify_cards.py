import json
from pathlib import Path

base = Path(__file__).resolve().parent
files = [base / 'content' / 'kanji.json', base / 'content' / 'vocabulary.json', base / 'content' / 'grammar.json']

for path in files:
    print(f'Checking {path.name}...')
    data = json.loads(path.read_text(encoding='utf-8'))
    issues = []
    ids = set()
    for i, item in enumerate(data):
        item_id = item.get('id')
        if not item_id:
            issues.append((i, 'missing id'))
        elif item_id in ids:
            issues.append((i, f'duplicate id {item_id}'))
        else:
            ids.add(item_id)
        for key in ['type', 'japanese', 'reading', 'meaning', 'example']:
            value = item.get(key)
            if value in (None, ''):
                issues.append((i, f'missing/empty {key}'))
        categories = item.get('categories', [])
        if not isinstance(categories, list):
            issues.append((i, 'categories is not a list'))
        elif not categories:
            issues.append((i, 'categories empty'))
    if issues:
        for issue in issues:
            print(' ', issue)
    else:
        print('  no issues found')
    print('  total items:', len(data))
