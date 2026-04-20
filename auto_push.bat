@echo off
chcp 65001 >nul
set "msg=%~1"
if "%msg%"=="" set "msg=update"

echo -----------------------------
echo [1/3] git add .
git add .
echo.

echo [2/3] git commit -m "%msg%"
git commit -m "%msg%"
echo.

echo [3/3] git push
git push
echo.

echo -----------------------------
echo complete
exit
