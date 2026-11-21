; Sampler Lab: installer hooks (NSIS, wired in tauri.conf.json -> bundle.windows.nsis).
; After installing, tell people without an NVIDIA card what that means for
; "Separar instrumentos" (everything else works the same on any PC).

!macro NSIS_HOOK_POSTINSTALL
  IfSilent sl_gpu_done
  nsExec::ExecToStack 'nvidia-smi --query-gpu=name --format=csv,noheader'
  Pop $0 ; exit code, or "error" if nvidia-smi isn't there
  Pop $1 ; output
  StrCmp $0 "0" sl_gpu_done
  MessageBox MB_OK|MB_ICONINFORMATION "Un aviso antes de empezar:$\r$\n$\r$\nNo encontramos una placa de video NVIDIA en esta PC. Todo Sampler Lab funciona igual, salvo una parte: $\"Separar instrumentos$\" (sacar la voz, la batería, el bajo... de un sample).$\r$\n$\r$\nTenés dos opciones, las elegís dentro de la app cuando la quieras usar:$\r$\n$\r$\n  • Usarla con el procesador: baja unos 250 MB una sola vez y anda bien con samples cortos (unos segundos cada uno). Con canciones enteras puede tardar varios minutos.$\r$\n$\r$\n  • No usarla: no instalás nada más y el resto de la app funciona completo."
  sl_gpu_done:
!macroend
