import Foundation
import Security

let args=CommandLine.arguments
guard args.count==3 else { fputs("usage: mac-keychain.swift get|set service\n",stderr); exit(2) }
let action=args[1],service=args[2]
let base:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"default"]

if action=="get" {
  var query=base
  query[kSecReturnData as String]=true
  query[kSecMatchLimit as String]=kSecMatchLimitOne
  var item:CFTypeRef?
  let status=SecItemCopyMatching(query as CFDictionary,&item)
  if status==errSecItemNotFound { exit(1) }
  guard status==errSecSuccess,let data=item as? Data else { exit(2) }
  FileHandle.standardOutput.write(data)
} else if action=="set" {
  let data=FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty else { fputs("missing value\n",stderr); exit(2) }
  let update=SecItemUpdate(base as CFDictionary,[kSecValueData as String:data] as CFDictionary)
  if update==errSecItemNotFound {
    var item=base
    item[kSecValueData as String]=data
    item[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status=SecItemAdd(item as CFDictionary,nil)
    guard status==errSecSuccess else { fputs("keychain write failed\n",stderr); exit(3) }
  } else if update != errSecSuccess { fputs("keychain update failed\n",stderr); exit(3) }
  print("OK")
} else { fputs("unknown action\n",stderr); exit(2) }
