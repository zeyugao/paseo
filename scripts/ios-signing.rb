require "base64"
require "fileutils"
require "json"
require "open3"
require "securerandom"
require "shellwords"

# Credentials stay outside the checkout and are removed by the workflow's always step.
directory = File.join(ENV.fetch("RUNNER_TEMP"), "paseo-ios-signing")
state_path = File.join(directory, "state.json")
keychain_path = File.join(directory, "signing.keychain-db")


def security(*arguments)
  output, error, status = Open3.capture3("/usr/bin/security", *arguments)
  raise "security #{arguments.first} failed: #{error}" unless status.success?
  output
end

case ARGV.fetch(0)
when "setup"
  require "plist"

  FileUtils.mkdir_p(directory, mode: 0o700)
  certificate_path = File.join(directory, "distribution.p12")
  profile_path = File.join(directory, "distribution.mobileprovision")
  api_key_path = File.join(directory, "AuthKey.p8")
  {
    certificate_path => Base64.strict_decode64(ENV.fetch("IOS_DISTRIBUTION_P12_BASE64").gsub(/\s+/, "")),
    profile_path => Base64.strict_decode64(ENV.fetch("IOS_PROVISION_PROFILE_BASE64").gsub(/\s+/, "")),
    api_key_path => ENV.fetch("ASC_PRIVATE_KEY"),
  }.each do |path, content|
    raise "Missing signing credential for #{File.basename(path)}" if content.empty?
    File.write(path, content, perm: 0o600)
  end

  profile = Plist.parse_xml(security("cms", "-D", "-i", profile_path))
  entitlements = profile.fetch("Entitlements")
  bundle_identifier = entitlements.fetch("application-identifier").split(".", 2).last
  unless bundle_identifier == ENV.fetch("IOS_BUNDLE_IDENTIFIER")
    raise "Provisioning profile does not match #{ENV.fetch('IOS_BUNDLE_IDENTIFIER')}"
  end
  if entitlements["get-task-allow"] || profile["ProvisionedDevices"] || profile["ProvisionsAllDevices"]
    raise "TestFlight requires an App Store distribution provisioning profile"
  end
  raise "Provisioning profile has expired" if profile.fetch("ExpirationDate").to_time <= Time.now

  team_id = profile.fetch("TeamIdentifier").first
  profile_name = profile.fetch("Name")
  uuid = profile.fetch("UUID")
  raise "Invalid provisioning profile UUID" unless uuid.match?(/\A[0-9a-f-]+\z/i)
  values = {
    "IOS_TEAM_ID" => team_id,
    "IOS_PROVISION_PROFILE_NAME" => profile_name,
    "IOS_KEYCHAIN_PATH" => keychain_path,
    "ASC_KEY_P8" => api_key_path,
  }
  values.each do |key, value|
    raise "Invalid signing environment value for #{key}" if !value.is_a?(String) || value.empty? || value.match?(/[\r\n]/)
  end

  # Xcode 16+ stores user provisioning profiles here.
  profiles_directory = File.expand_path("~/Library/Developer/Xcode/UserData/Provisioning Profiles")
  installed_profile = File.join(profiles_directory, "#{uuid}.mobileprovision")
  previous_keychains = Shellwords.split(security("list-keychains", "-d", "user"))
  File.write(state_path, JSON.generate({ "keychains" => previous_keychains, "profile" => installed_profile }), perm: 0o600)
  FileUtils.mkdir_p(profiles_directory)
  FileUtils.cp(profile_path, installed_profile)
  File.chmod(0o600, installed_profile)

  password = SecureRandom.hex(32)
  security("create-keychain", "-p", password, keychain_path)
  security("set-keychain-settings", "-lut", "21600", keychain_path)
  security("unlock-keychain", "-p", password, keychain_path)
  security("import", certificate_path, "-P", ENV.fetch("IOS_DISTRIBUTION_P12_PASSWORD"), "-t", "cert", "-f", "pkcs12", "-k", keychain_path, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security")
  security("set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain_path)
  security("list-keychains", "-d", "user", "-s", keychain_path, *previous_keychains)

  File.open(ENV.fetch("GITHUB_ENV"), "a") do |file|
    values.each { |key, value| file.puts("#{key}=#{value}") }
  end
when "cleanup"
  begin
    if File.exist?(state_path)
      state = JSON.parse(File.read(state_path))
      security("list-keychains", "-d", "user", "-s", *state.fetch("keychains"))
      FileUtils.rm_f(state.fetch("profile"))
    end
    security("delete-keychain", keychain_path) if File.exist?(keychain_path)
  ensure
    FileUtils.rm_rf(directory)
  end
else
  raise "Usage: ruby scripts/ios-signing.rb setup|cleanup"
end
