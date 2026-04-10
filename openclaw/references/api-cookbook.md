# API cookbook

Base URL: `http://localhost:3000`

## Create cache
`POST /api/caches` body `{ "label": "My Dataset" }`

## Upload files
`POST /api/upload` multipart fields:
- `cacheId`
- one or many `files`

## Generate plan context
`POST /api/cache-quick-summary/:cacheId`

## Generate model+strategy plans
`POST /api/index/feature-plans/:cacheId`
Body supports:
- `goal`
- `mainIntent`
- `applyDetectedRecipe`
- `openRouterKey` / env mode

## Index
`POST /api/index/:cacheId`
with `indexStrategy`, `indexStrategyNotes`, `indexOptions`

## Query
`POST /api/query/:cacheId`
body:
- `question`
- `mode`: `surreal` or `ai`
- optional strategy notes and model creds

## Diagnostics
- `POST /api/index-diagnose/:cacheId`
- `GET /api/schema/:cacheId`
- `POST /api/convert-surrealql/:cacheId`
- `GET /api/index-manifest/:cacheId`
- `GET /api/index-data-export/:cacheId`
