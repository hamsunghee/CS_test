# 반품 검수 MVP - HTML/CSS/JS + Google Apps Script

이 폴더는 Google AI Studio/React/Vite 없이 전직원이 링크로 사용할 수 있는 현장 입력용 MVP입니다.

## 포함 파일

- `index.html` : 앱 화면. 바코드 인식 안정성을 위해 `html5-qrcode` CDN을 사용합니다.
- `index-no-cdn.html` : 외부 CDN을 전혀 쓰지 않는 버전. 브라우저 기본 `BarcodeDetector` 지원 기기에서만 바코드 스캔이 됩니다.
- `style.css` : 모바일 UI 스타일
- `app.js` : 검수 입력, 바코드 스캔, 사진 압축, 로컬 저장, Apps Script 전송
- `apps-script/Code.gs` : Google Sheet/Drive에 저장하는 Apps Script 서버 코드

## 현재 기본 Apps Script URL

`app.js` 상단의 `DEFAULT_GAS_URL`에 아래 URL이 기본 입력되어 있습니다.

```text
https://script.google.com/macros/s/AKfycbw38AWma-DqnK8pQ-xhessKn6ZjFxYG_-znr1IAAVuL5mI9wEKdQTF3H6nbyzv9__Q/exec
```

앱의 `설정` 탭에서도 URL을 교체할 수 있습니다.

## 구현된 기능

- 송장번호 수기 입력
- 송장 바코드 스캔
  - `html5-qrcode` CDN 우선 사용
  - CDN 로딩 실패 시 브라우저 기본 `BarcodeDetector` fallback
  - 둘 다 불가하면 수기 입력
- 주문번호/상품명 입력
- 반품 사유 선택: 단순변심, 파손, 불량, 오배송, 기타
- 검수 결과 선택: 재입고, 폐기, 공장반품
- 사진 최대 4장 촬영/첨부 및 자동 압축
- Google Apps Script로 구글시트/드라이브 저장
- 로컬 임시 저장 및 전송 대기건 재전송
- 내역 검색/필터/CSV 내보내기
- 통계 보기

## 구현되지 않은 기능

- 송장 스캔 후 주문정보 자동조회
- 이카운트 ERP 자동 반영
- 카페24/이카운트 주문 매칭
- 직원 로그인/권한 관리
- 서버 DB 기반 실시간 관리자 화면

위 기능은 별도 API/백엔드 개발이 필요합니다.

## 배포 방법

### 1. 현장 직원용 웹앱 배포

`index.html`, `style.css`, `app.js`를 같은 폴더에 두고 HTTPS 호스팅에 업로드합니다.

가능한 예시:

- GitHub Pages
- Netlify
- Cloudflare Pages
- 사내 HTTPS 웹서버
- 카페24 웹호스팅 등 정적 호스팅

카메라 스캔은 브라우저 보안 정책상 HTTPS 환경에서 가장 안정적입니다.

### 2. Google Apps Script 배포

이미 제공하신 Apps Script URL을 계속 쓸 수도 있습니다.
다만 현재 URL을 브라우저에서 직접 열면 `doGet` 함수가 없다는 오류가 나오므로, 상태 확인 화면까지 원하면 `apps-script/Code.gs`로 교체하세요.

신규 설치 순서:

1. Google Sheet 생성
2. `확장 프로그램 > Apps Script`
3. `apps-script/Code.gs` 전체 붙여넣기
4. 저장
5. `배포 > 새 배포 > 웹 앱`
6. 실행 권한: `나`
7. 액세스 권한: 회사 정책에 맞게 선택
   - 완전 간편 운영: 모든 사용자
   - Google Workspace 내부 운영: 조직 내 사용자 또는 접근 제한 설정
8. 배포 후 Web App URL을 앱 설정 탭 또는 `app.js`에 입력

## 주의사항

- `fetch(..., mode: 'no-cors')` 방식이라 브라우저에서는 Apps Script 응답 내용을 직접 확인할 수 없습니다.
- 앱에서는 네트워크 요청이 완료되면 `전송 시도 성공`으로 표시합니다.
- 실제 저장 여부는 Google Sheet에 행이 추가되었는지 확인해야 합니다.
- 사진은 Apps Script가 실행되는 Google 계정의 Drive 폴더에 저장됩니다.
- 사진 링크 공유 범위는 `apps-script/Code.gs`의 `MAKE_PHOTO_LINK_PUBLIC` 값으로 제어합니다.
- 로컬 내역은 직원 각자의 휴대폰 브라우저에 저장됩니다. 브라우저 캐시 삭제/기기 변경 시 사라질 수 있습니다.

## 운영 추천

1차 MVP는 이 코드로 현장 입력과 구글시트 관리를 시작합니다.
2차에서 이카운트 API 연동 담당자가 Google Sheet 데이터를 기준으로 ERP 반영 자동화를 붙이는 방식을 추천합니다.
