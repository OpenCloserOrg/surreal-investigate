# SurrealQL examples

## Vector similarity + filter
```sql
SELECT name, price,
  <-bought<-person->bought->product.* AS also_bought
FROM product
WHERE embedding <|5,40|> $user_query_vector
  AND category = 'electronics'
  AND stock_count > 0;
```

## Relationship pattern
```sql
SELECT sourceValue, targetValue, type, count() AS links
FROM relation
WHERE cacheId = $cacheId
GROUP BY sourceValue, targetValue, type
ORDER BY links DESC
LIMIT 25;
```

## Time-window trend
```sql
SELECT filename, chunkIndex, dates, type, rawAmount
FROM event
WHERE cacheId = $cacheId
  AND (dates CONTAINS '2019' OR dates CONTAINS '2024')
ORDER BY filename, chunkIndex
LIMIT 200;
```

## Anomaly checks
```sql
SELECT type, severity, rationale, filename, chunkIndex
FROM anomaly
WHERE cacheId = $cacheId
ORDER BY severity DESC
LIMIT 100;
```

## Country extraction check
```sql
SELECT value, count() AS mentions
FROM entity
WHERE cacheId = $cacheId AND type CONTAINS 'location'
GROUP BY value
ORDER BY mentions DESC;
```
