# macromium (탭 클릭 후 닫기)

> 최종 갱신: 2026-10-13

## 무엇을 하는 프로젝트인가
Chrome/Edge/웨일용 MV3 확장 프로그램. 현재 창의 탭을 차례로 돌며 지정한 요소(또는 좌표)를 클릭 → 탭 닫기 → 대기를 반복하고, 마지막 탭 1개는 남긴다.

## 현재 상태
- 완료: v1.1.0 릴리스 배포됨 (https://github.com/menkinds/macromium/releases/tag/v1.1.0, zip 13개 파일 확인).
- 완료: 아이콘 배지 카운트다운, 유자 아이콘, 팝업 리디자인 — main에 머지됨 (PR #1, #2).
- 진행중/막힘: 없음.

## 파일
| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 매니페스트. `version` 이 릴리스 버전 |
| `background.js` | 서비스 워커. 실행 상태(`storage.local.run`), 스케줄링, 클릭 주입, 배지 카운트다운 |
| `popup.html` / `popup.css` / `popup.js` | 팝업 UI. 카운트다운 링, 진행 막대, 설정, 기록. 다크 모드 지원 |
| `picker.js` | 페이지에 주입되어 클릭할 요소의 선택자·좌표를 저장 |
| `icons/yuzu.svg` | 유자 아이콘 원본(팝업 헤더에서도 사용) |
| `icons/icon16/48/128.png` | 툴바·확장 페이지 아이콘 (16px는 단순화 버전) |
| `.github/workflows/release.yml` | 수동 실행 릴리스 워크플로 (zip 생성 + `v<version>` 릴리스) |
| `README.md` / `README_KO.md` | 설치 안내 / 상세 사용법 |

## 이번 세션에 한 일
- 2026-10-12: 툴바 아이콘 배지에 다음 실행까지 남은 초 표시 (`…`=실행 중, 100초 이상은 `Nm`). 크로미움에 로드해 2→1, 4→3→2→1 감소와 중지 시 사라짐 확인.
- 2026-10-12: 아이콘을 유자 모양으로 교체, 팝업을 유자 팔레트 카드 레이아웃 + 카운트다운 링으로 리디자인.
- 2026-10-12: PR #1 머지, 버전 1.1.0 + 릴리스 워크플로 추가(PR #2) 후 머지, 워크플로 실행으로 v1.1.0 릴리스 생성.

## 확정된 결정
- 배지 갱신은 서비스 워커에서 1초 `setInterval` 로 함 → 대기 중에도 워커가 잠들지 않게 하는 효과도 있음. `setRun()` 에서 `running=false` 면 배지를 지우는 방식으로 중지 경로를 한곳에 모음.
- 릴리스 zip 구조는 v1.0.0과 동일한 `macromium/` 폴더 루트 유지 (+ `icons/yuzu.svg`).
- 이 세션의 GitHub MCP에는 릴리스 생성 기능이 없어서 Actions 워크플로로 릴리스함.

## 다음에 할 일
- 특별히 남은 작업 없음. 새 버전을 낼 때: `manifest.json` 의 `version` 올림 → main 머지 → Actions → Release → Run workflow.
- (선택) `README.md` 에도 배지 설명 한 줄 추가 (현재 `README_KO.md` 에만 있음).

## 주의사항
- 아이콘 PNG 재생성: Playwright 크로미움으로 SVG를 렌더링 (`/opt/node22/lib/node_modules/playwright`, 16px는 별도 단순 SVG 사용). 스크립트는 저장소에 없음.
- 확장 동작 테스트: `launchPersistentContext` + `--load-extension` 으로 로드하고 로컬 http 서버 페이지를 써야 함 (`data:`, `about:blank` 탭에는 스크립트 주입 불가).
- 머지 API의 `expectedHeadSha` 는 40자 전체 해시 필요.
