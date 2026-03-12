@echo off
chcp 65001 > nul
echo.
echo  ====================================
echo   Liker Bottle - server.ts 起動中
echo  ====================================
echo.
echo  起動したら OBS の以下を開いてください:
echo  ・ブラウザソース  : source.html
echo  ・カスタムドック : controller.html
echo.
echo  終了するには このウィンドウを閉じてください。
echo.
deno run --allow-net server.ts
pause
