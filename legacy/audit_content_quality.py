import json
from pathlib import Path
from collections import Counter

base = Path(__file__).resolve().parent
files = [base / 'content' / 'kanji.json', base / 'content' / 'vocabulary.json']

for path in files:
    print(f'\n=== {path.name} ===')
    data = json.loads(path.read_text(encoding='utf-8'))
    meanings = Counter(item.get('meaning', '') for item in data)
    duplicates = [m for m, count in meanings.items() if count > 1]
    print('Duplicate meanings:', duplicates[:20] if duplicates else 'none')

    suspicious_readings = []
    for item in data:
        reading = item.get('reading', '')
        if '/' in reading and reading.count('/') > 2:
            suspicious_readings.append((item['id'], reading))
        elif len(reading) > 12:
            suspicious_readings.append((item['id'], reading))
        elif any(ch in reading for ch in ['〜', '・', '（', '）', '「', '」', '…']):
            suspicious_readings.append((item['id'], reading))
    print('Suspicious readings:', suspicious_readings[:20] if suspicious_readings else 'none')

    broad = []
    for item in data:
        meaning = item.get('meaning', '')
        if len(meaning.split()) > 4 or ',' in meaning:
            broad.append((item['id'], meaning))
    print('Broad meanings:', broad[:20] if broad else 'none')

    weak = []
    for item in data:
        if not item.get('example') or not item.get('categories'):
            weak.append((item['id'], item.get('japanese'), item.get('meaning')))
    print('Weak metadata examples:', weak[:20] if weak else 'none')
